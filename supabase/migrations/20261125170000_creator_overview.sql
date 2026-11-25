-- Part 3 (brief 3C): creator overview — one call for the analytics screen.
--
-- 7- and 28-day totals (views, like rate, followers gained, points earned),
-- best/worst recent post each with a tip from the shared rule table, and a
-- best-time-to-post histogram built from when the creator's audience swipes
-- their posts (hour of day, Europe/London; totals only, never who).
--
-- View counts come from the Part 3 roll-ups (bot-excluded at source), so they
-- only cover activity since view tracking shipped — older posts simply
-- contribute nothing, they don't error.

set search_path = public, extensions;

create or replace function public.get_creator_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _min_sample integer := public.setting_numeric('analytics_min_sample', 5)::integer;
  _week  jsonb;
  _month jsonb;
  _best  jsonb;
  _worst jsonb;
  _hours jsonb := '[]'::jsonb;
  _top_hour integer;
begin
  -- Windowed totals, one pass per window.
  select jsonb_build_object(
           'views', coalesce(sum(s.views) filter (where s.day >= w.d7), 0),
           'like_rate', (sum(s.right_swipes) filter (where s.day >= w.d7))::numeric
                        / nullif(sum(s.right_swipes + s.left_swipes) filter (where s.day >= w.d7), 0),
           'followers_gained', (select count(*) from public.follows f
                                where f.followee_id = auth.uid() and f.status = 'accepted'
                                  and f.created_at >= now() - interval '7 days'),
           'points_earned', (select coalesce(sum(l.delta), 0) from public.points_ledger l
                             where l.user_id = auth.uid() and l.delta > 0
                               and l.created_at >= now() - interval '7 days')),
         jsonb_build_object(
           'views', coalesce(sum(s.views), 0),
           'like_rate', sum(s.right_swipes)::numeric
                        / nullif(sum(s.right_swipes + s.left_swipes), 0),
           'followers_gained', (select count(*) from public.follows f
                                where f.followee_id = auth.uid() and f.status = 'accepted'
                                  and f.created_at >= now() - interval '28 days'),
           'points_earned', (select coalesce(sum(l.delta), 0) from public.points_ledger l
                             where l.user_id = auth.uid() and l.delta > 0
                               and l.created_at >= now() - interval '28 days'))
    into _week, _month
  from public.posts p
  join public.post_daily_stats s on s.post_id = p.id
  cross join (select ((now() at time zone 'Europe/London')::date - 7) as d7) w
  where p.user_id = auth.uid()
    and s.day >= ((now() at time zone 'Europe/London')::date - 28);

  -- Best and worst recent post (28 days of roll-ups, rateable samples only),
  -- each with its tip from the shared rule table.
  with rated as (
    select p.id, p.thumbnail_url, p.media_type, p.caption,
           sum(s.views)::bigint as views,
           sum(s.right_swipes)::numeric
             / nullif(sum(s.right_swipes + s.left_swipes), 0) as like_rate,
           sum(s.quick_skips)::numeric / nullif(sum(s.views), 0) as quick_skip_rate,
           sum(s.completions)::numeric / nullif(sum(s.video_views), 0) as completion_rate
    from public.posts p
    join public.post_daily_stats s on s.post_id = p.id
    where p.user_id = auth.uid()
      and s.day >= ((now() at time zone 'Europe/London')::date - 28)
    group by p.id, p.thumbnail_url, p.media_type, p.caption
    having sum(s.right_swipes + s.left_swipes) >= _min_sample
  ),
  pick as (
    select r.*,
           row_number() over (order by r.like_rate desc nulls last) as rn_best,
           row_number() over (order by r.like_rate asc  nulls last) as rn_worst,
           count(*) over () as total
    from rated r
    where r.like_rate is not null
  )
  select
    (select jsonb_build_object(
       'post_id', k.id, 'thumbnail_url', k.thumbnail_url, 'media_type', k.media_type,
       'caption', k.caption, 'views', k.views, 'like_rate', k.like_rate,
       'tip', public._pick_tip(k.quick_skip_rate, k.completion_rate, k.like_rate, null, null))
     from pick k where k.rn_best = 1),
    (select jsonb_build_object(
       'post_id', k.id, 'thumbnail_url', k.thumbnail_url, 'media_type', k.media_type,
       'caption', k.caption, 'views', k.views, 'like_rate', k.like_rate,
       'tip', public._pick_tip(k.quick_skip_rate, k.completion_rate, k.like_rate, null, null))
     from pick k where k.rn_worst = 1 and k.total > 1)  -- one post ≠ best AND worst
    into _best, _worst;

  -- Best time to post: when this creator's audience swipes their posts.
  -- Full swipe history (not the 90-day event window), hours in UK time.
  with by_hour as (
    select extract(hour from (sw.created_at at time zone 'Europe/London'))::integer as hour,
           count(*)::integer as swipes
    from public.swipes sw
    join public.posts p on p.id = sw.post_id
    where p.user_id = auth.uid()
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('hour', h.hour, 'swipes', h.swipes)
                            order by h.hour), '[]'::jsonb),
         (select h2.hour from by_hour h2 order by h2.swipes desc, h2.hour limit 1)
    into _hours, _top_hour
  from by_hour h;

  return jsonb_build_object(
    'week',  coalesce(_week,  jsonb_build_object('views', 0, 'like_rate', null,
               'followers_gained', 0, 'points_earned', 0)),
    'month', coalesce(_month, jsonb_build_object('views', 0, 'like_rate', null,
               'followers_gained', 0, 'points_earned', 0)),
    'best_post', _best,
    'worst_post', _worst,
    'hours', _hours,
    'top_hour', _top_hour
  );
end;
$fn$;
revoke all on function public.get_creator_overview() from public, anon, authenticated;
grant execute on function public.get_creator_overview() to authenticated;
