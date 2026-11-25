-- Part 3 (brief 3B): per-post insights + rule-based tips.
--
-- 1. `analytics_tip_rules` — plain-English tips as data, not code, so wording
--    and thresholds change without an app release (edited in fame-admin).
--    First matching rule by priority wins; `{band}` in the tip text is
--    replaced with the post's strongest age band when one clears the
--    aggregate floor.
-- 2. `get_post_insights(_post_id)` — everything the insights screen needs in
--    one call: headline like-rate + "better than N of your last 10", watch
--    stats + drop-off curve, audience breakdown, feed hearts separate from
--    deck likes, and the tip.
--
-- Privacy (Part 0 absolutes, enforced here):
--   * Own posts only.
--   * Left swipes only ever appear as totals.
--   * Audience groups smaller than `min_aggregate_group_size` (50) are merged
--     into "Other"; under-18 likers are ONE combined count, never broken down.
--   * date_of_birth never leaves the server — bands are computed in here.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Tip rules.
create table public.analytics_tip_rules (
  id         uuid primary key default gen_random_uuid(),
  metric     text not null check (metric in
               ('quick_skip_rate',   -- quick skips / views
                'completion_rate',   -- completions / video views (video posts)
                'like_rate',         -- bot-cleaned deck like rate
                'top_band_share',    -- top age band's share of likers (if band cleared the floor)
                'always')),          -- fallback, always matches
  comparator text not null check (comparator in ('gt', 'lt')),
  threshold  numeric not null,
  tip        text not null,          -- may contain {band}
  priority   integer not null,       -- lower runs first; first match wins
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

alter table public.analytics_tip_rules enable row level security;
-- No app access: evaluated inside definer fns, edited via service role only.
revoke all on table public.analytics_tip_rules from public, anon, authenticated;

insert into public.analytics_tip_rules (metric, comparator, threshold, tip, priority) values
  ('quick_skip_rate', 'gt', 0.4,  'Try a stronger first two seconds — a lot of viewers skipped early.', 10),
  ('completion_rate', 'lt', 0.3,  'Try a shorter video — most viewers didn''t reach the end.',          20),
  ('top_band_share',  'gt', 0.6,  'This works well with {band}s — more for them could land too.',       30),
  ('like_rate',       'gt', 0.7,  'This one landed. More like this!',                                   40),
  ('like_rate',       'lt', 0.3,  'Not every post travels — try a different angle or tag next time.',   50),
  ('always',          'gt', -1,   'Keep posting — every view sharpens what we can tell you.',           100);

-- ---------------------------------------------------------------------------
-- 2. Shared tip evaluator (also used by the Part 3 overview).
create or replace function public._pick_tip(
  _quick_skip_rate numeric,  -- null when unknown
  _completion_rate numeric,  -- null for non-video / no video views
  _like_rate       numeric,  -- null when sample-suppressed
  _top_band        text,     -- null when no band cleared the floor
  _top_band_share  numeric   -- null when no band cleared the floor
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  r record;
  v numeric;
begin
  for r in
    select t.metric, t.comparator, t.threshold, t.tip
    from public.analytics_tip_rules t
    where t.active
    order by t.priority, t.id
  loop
    v := case r.metric
           when 'quick_skip_rate' then _quick_skip_rate
           when 'completion_rate' then _completion_rate
           when 'like_rate'       then _like_rate
           when 'top_band_share'  then _top_band_share
           else 0
         end;
    if r.metric = 'always'
       or (v is not null and
           ((r.comparator = 'gt' and v > r.threshold) or
            (r.comparator = 'lt' and v < r.threshold)))
    then
      if r.metric = 'top_band_share' and _top_band is null then
        continue;  -- band tip without a disclosable band
      end if;
      return replace(r.tip, '{band}', coalesce(_top_band, ''));
    end if;
  end loop;
  return null;
end;
$fn$;
revoke all on function public._pick_tip(numeric, numeric, numeric, text, numeric)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The insights call.
create or replace function public.get_post_insights(_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _min_sample integer := public.setting_numeric('analytics_min_sample', 5)::integer;
  _min_views  integer := public.setting_numeric('analytics_min_views_for_insights', 50)::integer;
  _floor      integer := public.setting_numeric('min_aggregate_group_size', 50)::integer;
  p           public.posts;
  _bot_likes  integer := 0;
  _bot_skips  integer := 0;
  _likes      integer;
  _skips      integer;
  _total      integer;
  _like_rate  numeric;
  _better     integer;
  _recent     integer;
  _views          bigint := 0;
  _quick          bigint := 0;
  _dwell_sum      bigint := 0;
  _video_views    bigint := 0;
  _completions    bigint := 0;
  _completion     numeric;
  _quick_rate     numeric;
  _dropoff        jsonb := '[]'::jsonb;
  _drop_sentence_s integer;
  _bands          jsonb := '[]'::jsonb;
  _under18        integer := 0;
  _top_band       text;
  _top_band_share numeric;
  _regions        jsonb := '[]'::jsonb;
  _interests      jsonb := '[]'::jsonb;
  _liker_count    integer := 0;
  _tip            text;
begin
  select * into p from public.posts where id = _post_id;
  if not found or p.user_id <> auth.uid() then
    raise exception 'not authorised';  -- own posts only
  end if;

  -- Headline: bot-cleaned lifetime counters (same basis as get_post_analytics).
  select bc.bot_like_count, bc.bot_skip_count into _bot_likes, _bot_skips
  from public.post_bot_counts bc where bc.post_id = _post_id;
  _likes := greatest(p.like_count - coalesce(_bot_likes, 0), 0);
  _skips := greatest(p.skip_count - coalesce(_bot_skips, 0), 0);
  _total := _likes + _skips;
  _like_rate := case when _total >= _min_sample
                     then _likes::numeric / _total else null end;

  -- "Better than N of your last 10 posts" (rateable earlier posts only).
  select count(*) filter (where _like_rate is not null and prev.rate < _like_rate),
         count(*)
    into _better, _recent
  from (
    select greatest(p2.like_count - coalesce(bc2.bot_like_count, 0), 0)::numeric
           / nullif(greatest(p2.like_count - coalesce(bc2.bot_like_count, 0), 0)
                  + greatest(p2.skip_count - coalesce(bc2.bot_skip_count, 0), 0), 0) as rate
    from public.posts p2
    left join public.post_bot_counts bc2 on bc2.post_id = p2.id
    where p2.user_id = auth.uid()
      and p2.id <> _post_id
      and p2.created_at < p.created_at
      and (greatest(p2.like_count - coalesce(bc2.bot_like_count, 0), 0)
         + greatest(p2.skip_count - coalesce(bc2.bot_skip_count, 0), 0)) >= _min_sample
    order by p2.created_at desc
    limit 10
  ) prev
  where prev.rate is not null;

  -- Watch stats + drop-off from the daily roll-ups.
  select coalesce(sum(s.views), 0), coalesce(sum(s.quick_skips), 0),
         coalesce(sum(s.dwell_ms_sum), 0),
         coalesce(sum(s.video_views), 0), coalesce(sum(s.completions), 0)
    into _views, _quick, _dwell_sum, _video_views, _completions
  from public.post_daily_stats s where s.post_id = _post_id;

  _quick_rate := case when _views > 0 then _quick::numeric / _views else null end;
  _completion := case when _video_views > 0
                      then _completions::numeric / _video_views else null end;

  if _video_views > 0 then
    -- Merge the sparse per-day stop histograms, then turn them into
    -- "viewers still watching at second s" out of all video viewers.
    with stops as (
      select (kv.key)::integer as sec, sum((kv.value)::numeric)::bigint as n
      from public.post_daily_stats s,
           lateral jsonb_each_text(s.stop_positions) kv
      where s.post_id = _post_id
      group by 1
    ),
    curve as (
      select st.sec,
             (_video_views - coalesce(
                sum(st.n) over (order by st.sec rows between unbounded preceding
                                and 1 preceding), 0))::bigint as watching_at_start,
             st.n
      from stops st
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'sec', c.sec, 'watching', c.watching_at_start) order by c.sec), '[]'::jsonb),
           (select c2.sec from curve c2 order by c2.n desc, c2.sec limit 1)
      into _dropoff, _drop_sentence_s
    from curve c;
  end if;

  -- Audience: likers only (right swipes are discloseable as aggregates; the
  -- individual likers list is Part 4). Left swipes never appear here.
  select count(*) into _liker_count
  from public.swipes sw where sw.post_id = _post_id and sw.direction = 'right';

  if _liker_count > 0 then
    -- Age bands. Adults land in bands; minors are ONE combined count, shown
    -- only when it clears the aggregate floor, otherwise folded into Other
    -- (a smaller disclosure, never a finer one). Any adult band under the
    -- floor folds into Other too. The strongest disclosable adult band feeds
    -- the {band} tip.
    with banded as (
      select case
               when pr.age_band = 'minor' then 'under18'
               when a.age_y is null then 'Other'
               when a.age_y < 25 then '18-24'
               when a.age_y < 35 then '25-34'
               when a.age_y < 45 then '35-44'
               when a.age_y < 55 then '45-54'
               else '55+'
             end as band
      from public.swipes sw
      join public.profiles pr on pr.id = sw.user_id
      cross join lateral (
        select extract(year from age((now() at time zone 'Europe/London')::date,
                                     pr.date_of_birth))::integer as age_y
      ) a
      where sw.post_id = _post_id and sw.direction = 'right'
    ),
    counted as (select b.band, count(*)::integer as n from banded b group by b.band),
    u18 as (select coalesce(sum(c.n), 0)::integer as n from counted c where c.band = 'under18'),
    folded as (
      select case when c.band <> 'under18' and c.n >= _floor then c.band
                  else 'Other' end as band,
             sum(c.n)::integer as n
      from counted c
      where c.band <> 'under18' or c.n < _floor  -- a disclosable minor count stays out of Other
      group by 1
    ),
    top_band as (
      select c.band, c.n from counted c
      where c.band <> 'under18' and c.band <> 'Other' and c.n >= _floor
      order by c.n desc limit 1
    )
    select case when u.n >= _floor then u.n end,
           coalesce((select jsonb_agg(jsonb_build_object('band', f.band, 'likes', f.n)
                                      order by f.n desc)
                     from folded f), '[]'::jsonb),
           (select t.band from top_band t),
           (select t.n::numeric / _liker_count from top_band t)
      into _under18, _bands, _top_band, _top_band_share
    from u18 u;

    -- Regions: the likers' self-set location labels; unlabelled or small
    -- groups fold into Other. Under-18s never enter any breakdown.
    with by_label as (
      select pr.search_center_label as label, count(*)::integer as n
      from public.swipes sw
      join public.profiles pr on pr.id = sw.user_id
      where sw.post_id = _post_id and sw.direction = 'right'
        and pr.age_band <> 'minor'
      group by pr.search_center_label
    ),
    folded as (
      select case when l.label is not null and l.n >= _floor then l.label
                  else 'Other' end as region,
             sum(l.n)::integer as n
      from by_label l
      group by 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('region', f.region, 'likes', f.n)
                              order by f.n desc), '[]'::jsonb)
      into _regions
    from folded f;

    -- Top interests: tags the likers follow (positive affinity), floored at 50.
    select coalesce(jsonb_agg(jsonb_build_object('tag', g.tag, 'likes', g.n)
                              order by g.n desc), '[]'::jsonb)
      into _interests
    from (
      select t.name as tag, count(distinct sw.user_id)::integer as n
      from public.swipes sw
      join public.profiles pr on pr.id = sw.user_id and pr.age_band <> 'minor'
      join public.user_tags ut on ut.user_id = sw.user_id and ut.weight > 0
      join public.tags t on t.id = ut.tag_id
      where sw.post_id = _post_id and sw.direction = 'right'
      group by t.name
      having count(distinct sw.user_id) >= _floor
      order by count(distinct sw.user_id) desc
      limit 5
    ) g;
  end if;

  _tip := public._pick_tip(_quick_rate, _completion, _like_rate,
                           _top_band, _top_band_share);

  return jsonb_build_object(
    'deck_likes', _likes,
    'deck_skips', _skips,
    'feed_likes', p.feed_like_count,
    'comments', p.comment_count,
    'reach', p.reach_count,
    'like_rate', _like_rate,
    'better_than', case when _like_rate is not null then _better end,
    'recent_count', _recent,
    'sample_suppressed', (_total < _min_sample),
    'min_views', _min_views,
    'enough_views', (_views >= _min_views or _total >= _min_views),
    'watch', jsonb_build_object(
      'views', _views,
      'quick_skip_rate', _quick_rate,
      'avg_dwell_ms', case when _views > 0 then round(_dwell_sum::numeric / _views) end,
      'video_views', _video_views,
      'completion_rate', _completion,
      'dropoff', _dropoff,
      'dropoff_peak_sec', _drop_sentence_s
    ),
    'audience', jsonb_build_object(
      'likers', _liker_count,
      'age_bands', _bands,
      'under18_likes', _under18,
      'regions', _regions,
      'interests', _interests
    ),
    'tip', _tip
  );
end;
$fn$;
revoke all on function public.get_post_insights(uuid) from public, anon, authenticated;
grant execute on function public.get_post_insights(uuid) to authenticated;
