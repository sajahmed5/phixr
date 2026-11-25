-- Part 3 (brief 3A): daily per-post analytics roll-ups.
--
-- Rolls raw `post_view_events` (Part 1) up into one row per post per UK day:
-- views, right/left swipes, quick skips, dwell time, video views/completions,
-- and a sparse per-second histogram of where non-completing viewers stopped
-- watching (the drop-off curve's raw material). Part 1's ingest already
-- refuses the creator's own views and non-public/unapproved posts, so the
-- only exclusion applied here is bot-flagged events (`flagged`).
--
-- Raw events are purged after 90 days (`view-events-purge`); these roll-ups
-- are the durable record. The refresh job re-aggregates a trailing window of
-- days every 15 minutes (idempotent delete+insert), never the whole table.
--
-- No app-role access: creators read their stats only through the Part 3
-- definer functions, which enforce own-posts-only.

set search_path = public, extensions;

-- 1. Tuning values (admin-editable, Part 0 rule: no hard-coded numbers).
insert into public.platform_settings (key, value, description, client_visible) values
  ('analytics_rollup_lookback_days', '2'::jsonb,
   'How many trailing days the 15-minute analytics roll-up job re-aggregates. Must cover the longest realistic client flush delay.', false),
  ('analytics_min_views_for_insights', '50'::jsonb,
   'Minimum rolled-up views before a post''s insights screen shows real numbers; below it the app shows "check back after N views".', true)
on conflict (key) do nothing;

-- 2. The roll-up table. Day boundaries are Europe/London (UK-first product).
create table public.post_daily_stats (
  post_id        uuid not null references public.posts (id) on delete cascade,
  day            date not null,
  views          integer not null default 0,  -- unflagged view events, incl. direction 'none'
  right_swipes   integer not null default 0,
  left_swipes    integer not null default 0,
  quick_skips    integer not null default 0,  -- left swipes under quick_skip_ms
  dwell_ms_sum   bigint  not null default 0,
  video_views    integer not null default 0,  -- events that carried a video position
  completions    integer not null default 0,
  -- {"<second>": n} — viewers whose FINAL position fell in that second and who
  -- did NOT complete. Completers never "drop", so the drop-off curve is
  -- video_views minus the running total of this histogram.
  stop_positions jsonb   not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  primary key (post_id, day)
);
create index post_daily_stats_day_idx on public.post_daily_stats (day);

alter table public.post_daily_stats enable row level security;
-- No policies and no app grants on purpose: reads go through definer fns.
revoke all on table public.post_daily_stats from public, anon, authenticated;

-- 3. The refresh job body.
create or replace function public.refresh_post_daily_stats()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _lookback integer := greatest(public.setting_numeric('analytics_rollup_lookback_days', 2)::integer, 1);
  _quick    numeric := public.setting_numeric('quick_skip_ms', 2000);
  _from     date := ((now() at time zone 'Europe/London')::date - _lookback);
begin
  delete from public.post_daily_stats s where s.day >= _from;

  insert into public.post_daily_stats
    (post_id, day, views, right_swipes, left_swipes, quick_skips,
     dwell_ms_sum, video_views, completions, stop_positions, updated_at)
  with base as (
    select e.post_id,
           (e.shown_at at time zone 'Europe/London')::date as day,
           e.direction, e.dwell_ms, e.video_position_ms, e.video_completed
    from public.post_view_events e
    where not e.flagged
      and (e.shown_at at time zone 'Europe/London')::date >= _from
  ),
  agg as (
    select b.post_id, b.day,
           count(*)::integer as views,
           count(*) filter (where b.direction = 'right')::integer as right_swipes,
           count(*) filter (where b.direction = 'left')::integer  as left_swipes,
           count(*) filter (where b.direction = 'left' and b.dwell_ms < _quick)::integer as quick_skips,
           coalesce(sum(b.dwell_ms), 0)::bigint as dwell_ms_sum,
           count(*) filter (where b.video_position_ms is not null)::integer as video_views,
           count(*) filter (where b.video_completed)::integer as completions
    from base b
    group by b.post_id, b.day
  ),
  stops as (
    select s.post_id, s.day, jsonb_object_agg(s.sec::text, s.n) as stop_positions
    from (
      select b.post_id, b.day,
             floor(b.video_position_ms / 1000.0)::integer as sec,
             count(*) as n
      from base b
      where b.video_position_ms is not null and not b.video_completed
      group by b.post_id, b.day, sec
    ) s
    group by s.post_id, s.day
  )
  select a.post_id, a.day, a.views, a.right_swipes, a.left_swipes, a.quick_skips,
         a.dwell_ms_sum, a.video_views, a.completions,
         coalesce(st.stop_positions, '{}'::jsonb),
         now()
  from agg a
  left join stops st on st.post_id = a.post_id and st.day = a.day;
end;
$fn$;
revoke all on function public.refresh_post_daily_stats() from public, anon, authenticated;

-- 4. Every 15 minutes, offset from creator-quality's run.
select cron.schedule('post-daily-rollup', '7,22,37,52 * * * *',
                     $$select public.refresh_post_daily_stats();$$)
where not exists (select 1 from cron.job where jobname = 'post-daily-rollup');
