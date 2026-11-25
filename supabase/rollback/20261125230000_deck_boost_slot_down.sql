-- Rollback for 20261125230000_deck_boost_slot.
-- Restores get_deck v4 (no is_boosted) and record_view_events v2 (no boost
-- serving counter), both verbatim from 20261125110000_deck_quality_explore.
-- Roll this back BEFORE 20261125220000_boosts.

set search_path = public, extensions;

drop function if exists public.get_deck(integer, uuid[]);
create function public.get_deck(_limit integer default 20, _exclude uuid[] default '{}')
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
  with cfg as (
    select
      greatest(round(_limit::numeric / greatest(coalesce(
        public.effective_numeric_setting(auth.uid(), 'explore_share_one_in'), 8), 2))::integer, 1) as explore_quota,
      public.setting_numeric('quality_fast_skip_weight', 1)       as fsw,
      public.setting_numeric('quality_completion_weight', 1)      as cw,
      public.setting_numeric('creator_fast_skip_threshold', 0.4)  as cp_thresh,
      public.setting_numeric('creator_penalty_scale', 2)          as cp_scale,
      public.setting_numeric('creator_fast_skip_penalty_max', 0.5) as cp_max
  ),
  viewer_cells as (
    select public.local_cells(
             extensions.st_y(pr.search_location::extensions.geometry),
             extensions.st_x(pr.search_location::extensions.geometry),
             pr.search_radius_miles * 1609.34) as cells
    from public.profiles pr
    where pr.id = auth.uid() and pr.search_location is not null
  ),
  base as (
    select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption,
           p.alt_text, p.like_count, p.skip_count, p.comment_count, p.created_at,
           p.overlays, p.location_cell
    from public.posts p
    where p.visibility = 'public'
      and p.moderation_status = 'approved'
      and p.user_id <> auth.uid()
      and p.id <> all(_exclude)
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
      -- Laplace-smoothed like-rate on BOT-CLEANED counts (Part 1C).
      (greatest(b.like_count - coalesce(bc.bot_like_count, 0), 0) + 1.0)
        / (greatest(b.like_count - coalesce(bc.bot_like_count, 0), 0)
           + greatest(b.skip_count - coalesce(bc.bot_skip_count, 0), 0) + 2.0) as like_quality,
      -- Quick-skip rate, smoothed so a new post sits near 0 (can't be sunk early).
      coalesce(q.fast_skips, 0)::double precision
        / (coalesce(q.likes, 0) + coalesce(q.skips, 0) + 10.0) as fast_skip_rate,
      -- Completion bonus for videos, smoothed the same way.
      case when b.media_type = 'video'
           then coalesce(q.completions, 0)::double precision / (coalesce(q.video_views, 0) + 10.0)
           else 0.0 end as completion_rate,
      -- Creator repeat-pattern penalty: gentle, capped, recovers via the cron.
      least((select cp_max from cfg),
            greatest(0.0, coalesce(cq.fast_skip_rate, 0) - (select cp_thresh from cfg))
              * (select cp_scale from cfg)) as creator_penalty,
      case
        when now() - pr.created_at < interval '14 days'
        then 2.0 * (1.0 - extract(epoch from (now() - pr.created_at)) / (14.0 * 86400.0))
        else 0.0
      end as newcomer_boost
    from base b
    join public.profiles pr on pr.id = b.user_id
    left join public.post_bot_counts bc on bc.post_id = b.id
    left join public.post_quality q on q.post_id = b.id
    left join public.creator_quality cq on cq.user_id = b.user_id
  ),
  ranked2 as (
    select r.*,
      (greatest(r.like_quality - (select fsw from cfg) * r.fast_skip_rate, 0.0)
        + (select cw from cfg) * r.completion_rate) as quality
    from ranked r
  ),
  ranked3 as (
    select r2.*,
      (r2.affinity * 3.0
        + r2.freshness * 2.0
        + r2.quality * 2.0
        + r2.points_boost * 0.5
        + r2.newcomer_boost
        - r2.creator_penalty * 2.0) as score
    from ranked2 r2
  ),
  capped as (
    select r3.*, row_number() over (partition by r3.user_id order by r3.score desc) as creator_rn
    from ranked3 r3
  ),
  diverse as (
    select * from capped where creator_rn <= 2
  ),
  matched as (
    select * from diverse where affinity > 0
    order by score desc
    limit greatest(_limit - (select explore_quota from cfg), 0)
  ),
  explore as (
    select e.* from (
      select d.*,
        -- Category rotation: the best post of each top tag ranks first, so
        -- explore isn't always the same second interest.
        row_number() over (
          partition by (select min(pt.tag_id::text) from public.post_tags pt where pt.post_id = d.id)
          order by d.escore desc
        ) as tag_rn
      from (
        select d0.*,
          (d0.freshness * 2.0 + d0.quality * 2.0 + d0.points_boost * 0.5
            + d0.newcomer_boost - d0.creator_penalty * 2.0
            + case when d0.location_cell is not null
                    and d0.location_cell = any(coalesce((select cells from viewer_cells), array[]::text[]))
                   then 0.5 else 0.0 end
            + random() * 0.3) as escore
        from diverse d0
        where d0.affinity <= 0
          and d0.id not in (select id from matched)
      ) d
    ) e
    order by e.tag_rn asc, e.escore desc
    limit (select explore_quota from cfg)
  ),
  backfill as (
    select * from diverse
    where id not in (select id from matched)
      and id not in (select id from explore)
    order by score desc
    limit greatest(_limit - (select count(*) from matched) - (select count(*) from explore), 0)
  ),
  combined as (
    -- Part 8 ad insertion point: slots every my_ad_frequency() cards.
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score
    from matched
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score
    from explore
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score
    from backfill
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
    returning post_id, dwell_ms, direction, video_position_ms, video_completed
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
  )
  select count(*) into _n from inserted;

  perform public._flag_bot_patterns(_uid);
  return _n;
end;
$fn$;
revoke all on function public.record_view_events(jsonb) from public, anon;
grant execute on function public.record_view_events(jsonb) to authenticated;
