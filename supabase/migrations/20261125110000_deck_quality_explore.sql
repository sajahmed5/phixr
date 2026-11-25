-- ============================================================================
-- 20261125110000_deck_quality_explore  (Build brief Parts 2B, 2C, 2D)
--
-- 2B — clickbait skip penalty. Watch time (Part 1B) now feeds ranking:
--   * post_quality: per-post aggregates (views, likes/skips, QUICK skips —
--     a skip under quick_skip_ms — video views/completions, watch time),
--     updated incrementally inside record_view_events. Bot-flagged events are
--     excluded: _flag_bot_patterns retro-decrements the aggregates when it
--     catches a batch. Everything Laplace-smoothed downstream, so a handful
--     of swipes on a new post can't sink it; the newcomer boost is untouched.
--   * creator_quality: a creator's recency-weighted fast-skip rate over their
--     last 30 days of public posts (half-life creator_penalty_halflife_days),
--     recomputed every 15 min by pg_cron. get_deck applies a gentle, capped
--     penalty above creator_fast_skip_threshold — and because the rate is
--     recomputed from recent posts, reach RECOVERS when content improves.
--
-- 2C — guaranteed explore share. The old deck gave explore whatever was left
-- after matched posts took 90%. Now: explore_quota = round(limit /
-- explore_share_one_in), per-user effective (overridable, engagement-
-- adjustable). Explore picks rotate across categories (one post per top tag
-- first), favour local posts (viewer's existing coarse search cells, +bonus),
-- and keep the newcomer boost. Explore-pool is affinity <= 0 — with Part 2's
-- affinity learning, actively-avoided tags (negative weight) sort last.
-- Unfilled slots backfill from the best remaining posts, so the deck never
-- comes up short because explore ran dry.
--
-- 2D — ad slots. my_ad_frequency() returns this user's randomised N (one ad
-- every N cards) from the EFFECTIVE ad_frequency_min/max — heavier users get
-- slightly more frequent ads via the Part 1 engagement deltas. Per the brief,
-- no empty placeholder is injected into the deck: Part 8 will call this
-- function when inserting real ad cards (insertion point: the `combined` CTE
-- in get_deck below).
-- ============================================================================

set search_path = public, extensions;

insert into public.platform_settings (key, value, description, client_visible) values
  ('creator_fast_skip_threshold', '0.4'::jsonb, 'Recency-weighted fast-skip rate above which a creator''s repeat-pattern penalty starts (Part 2B).', false),
  ('creator_penalty_scale',       '2'::jsonb,   'Multiplier turning (rate − threshold) into the creator penalty, capped at creator_fast_skip_penalty_max.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Aggregate tables (no app-role access; written only by definer functions)
-- ---------------------------------------------------------------------------
create table public.post_quality (
  post_id     uuid primary key references public.posts (id) on delete cascade,
  views       integer not null default 0,   -- unflagged view events, incl. 'none'
  likes       integer not null default 0,   -- right-swipe view events
  skips       integer not null default 0,   -- left-swipe view events
  fast_skips  integer not null default 0,   -- left swipes under quick_skip_ms
  video_views integer not null default 0,
  completions integer not null default 0,
  watch_ms    bigint  not null default 0,
  updated_at  timestamptz not null default now()
);
comment on table public.post_quality is
  'Per-post watch-time aggregates from unflagged view events (Part 2B). Fed incrementally by record_view_events; bot flags retro-decrement.';
alter table public.post_quality enable row level security;
revoke all on public.post_quality from anon, authenticated;

create table public.creator_quality (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  fast_skip_rate real not null default 0,   -- recency-weighted, Laplace-smoothed
  sample         integer not null default 0,
  updated_at     timestamptz not null default now()
);
comment on table public.creator_quality is
  'Recency-weighted fast-skip rate per creator over recent public posts (Part 2B repeat penalty). Recomputed by pg_cron; absence = no penalty.';
alter table public.creator_quality enable row level security;
revoke all on public.creator_quality from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. record_view_events re-emit (body from 20261124100000): same validation
-- and idempotency; NEW: each batch increments post_quality.
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

-- ---------------------------------------------------------------------------
-- 3. _flag_bot_patterns re-emit (body from 20261124100000). NEW: newly
-- flagged events are retro-removed from post_quality, so flagged engagement
-- never shapes the 2B quality signal either.
-- ---------------------------------------------------------------------------
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
  _quick     numeric := public.setting_numeric('quick_skip_ms', 2000);
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

  -- Flag (first time only — trust is charged once per event), move the flagged
  -- like/skip totals out of the rankable counts, and retro-remove the events
  -- from the 2B quality aggregates.
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
    returning e.post_id, e.direction, e.dwell_ms, e.video_position_ms, e.video_completed
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
  ),
  quality_dec as (
    update public.post_quality pq
    set views       = greatest(pq.views       - d.views, 0),
        likes       = greatest(pq.likes       - d.likes, 0),
        skips       = greatest(pq.skips       - d.skips, 0),
        fast_skips  = greatest(pq.fast_skips  - d.fast_skips, 0),
        video_views = greatest(pq.video_views - d.video_views, 0),
        completions = greatest(pq.completions - d.completions, 0),
        watch_ms    = greatest(pq.watch_ms    - d.watch_ms, 0),
        updated_at  = now()
    from (
      select f.post_id,
        count(*) as views,
        count(*) filter (where f.direction = 'right') as likes,
        count(*) filter (where f.direction = 'left') as skips,
        count(*) filter (where f.direction = 'left' and f.dwell_ms < _quick) as fast_skips,
        count(*) filter (where f.video_position_ms is not null or f.video_completed is not null) as video_views,
        count(*) filter (where f.video_completed) as completions,
        coalesce(sum(f.dwell_ms), 0) as watch_ms
      from flagged_now f
      group by f.post_id
    ) d
    where pq.post_id = d.post_id
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

-- ---------------------------------------------------------------------------
-- 4. Creator repeat-pattern penalty: recency-weighted fast-skip rate.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_creator_quality()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _halflife numeric := greatest(public.setting_numeric('creator_penalty_halflife_days', 7), 0.5);
begin
  with recent as (
    select p.user_id,
           sum(q.fast_skips * w.wt) as fs,
           sum((q.likes + q.skips) * w.wt) as sw
    from public.posts p
    join public.post_quality q on q.post_id = p.id
    cross join lateral (
      select exp(-ln(2.0) * extract(epoch from (now() - p.created_at)) / (_halflife * 86400.0)) as wt
    ) w
    where p.visibility = 'public'
      and p.created_at > now() - interval '30 days'
    group by p.user_id
  ),
  upserted as (
    insert into public.creator_quality as cq (user_id, fast_skip_rate, sample, updated_at)
    select r.user_id,
           coalesce(r.fs / nullif(r.sw + 10.0, 0), 0),  -- Laplace-smoothed: tiny samples ≈ no penalty
           round(r.sw)::integer,
           now()
    from recent r
    on conflict (user_id) do update
      set fast_skip_rate = excluded.fast_skip_rate,
          sample = excluded.sample,
          updated_at = now()
    returning cq.user_id
  )
  -- No recent public posts → no penalty row at all (full recovery).
  delete from public.creator_quality c
  where c.user_id not in (select u.user_id from upserted u);
end;
$fn$;
revoke all on function public.refresh_creator_quality() from public, anon, authenticated;

select cron.schedule('creator-quality', '*/15 * * * *', $$select public.refresh_creator_quality();$$)
  where not exists (select 1 from cron.job where jobname = 'creator-quality');

-- ---------------------------------------------------------------------------
-- 5. Ad slot groundwork (2D): the per-user randomised interval. Part 8 calls
-- this when inserting ad cards; until then nothing is injected (no empty
-- placeholders, per the brief).
-- ---------------------------------------------------------------------------
create or replace function public.my_ad_frequency()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  _min numeric := greatest(coalesce(public.effective_numeric_setting(auth.uid(), 'ad_frequency_min'), 15), 1);
  _max numeric;
begin
  if auth.uid() is null then
    raise exception 'my_ad_frequency: not authenticated';
  end if;
  _max := greatest(coalesce(public.effective_numeric_setting(auth.uid(), 'ad_frequency_max'), 20), _min);
  return (_min + floor(random() * (_max - _min + 1)))::integer;
end;
$fn$;
revoke all on function public.my_ad_frequency() from public, anon;
grant execute on function public.my_ad_frequency() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. get_deck re-emit (body from 20261124100000). Changes:
--   * quality = Laplace like-rate (bot-cleaned) − fast-skip penalty
--     + completion bonus (videos), weights from settings;
--   * creator repeat-pattern penalty, capped, recovering;
--   * GUARANTEED explore quota (effective explore_share_one_in), rotated
--     across categories (one per top tag first), local bonus, backfill;
--   * explore pool is affinity <= 0 (negative = actively avoided sorts last
--     via escore's quality/score inputs and the matched filter).
-- Return signature unchanged. Ad insertion point for Part 8: `combined`.
-- ---------------------------------------------------------------------------
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
