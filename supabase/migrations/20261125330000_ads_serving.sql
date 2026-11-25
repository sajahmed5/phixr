-- Part 8 (serving + reporting): the deck ad slot, ad-aware event ingest and
-- the advertiser report. See 20261125320000 for the platform commentary.

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
  overlays            jsonb,
  is_boosted          boolean,
  sensitive           boolean,
  is_ad               boolean,
  ad_id               uuid,
  cta_label           text,
  cta_url             text,
  ad_reason           text
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
      greatest(round(_limit::numeric / greatest(
        public.setting_numeric('boost_slot_one_in', 8), 2))::integer, 1) as boost_quota,
      public.setting_numeric('quality_fast_skip_weight', 1)       as fsw,
      public.setting_numeric('quality_completion_weight', 1)      as cw,
      public.setting_numeric('creator_fast_skip_threshold', 0.4)  as cp_thresh,
      public.setting_numeric('creator_penalty_scale', 2)          as cp_scale,
      public.setting_numeric('creator_fast_skip_penalty_max', 0.5) as cp_max
  ),
  viewer as (
    select pr.id, pr.age_band, pr.search_center_label,
           case
             when pr.date_of_birth is null then null
             when extract(year from age((now() at time zone 'Europe/London')::date,
                                        pr.date_of_birth)) < 25 then '18-24'
             when extract(year from age((now() at time zone 'Europe/London')::date,
                                        pr.date_of_birth)) < 35 then '25-34'
             when extract(year from age((now() at time zone 'Europe/London')::date,
                                        pr.date_of_birth)) < 45 then '35-44'
             when extract(year from age((now() at time zone 'Europe/London')::date,
                                        pr.date_of_birth)) < 55 then '45-54'
             else '55+'
           end as band
    from public.profiles pr where pr.id = auth.uid()
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
           p.overlays, p.location_cell, p.sensitive
    from public.posts p
    where p.visibility = 'public'
      and p.moderation_status = 'approved'
      and p.user_id <> auth.uid()
      and p.id <> all(_exclude)
      and exists (
        select 1 from public.profiles pr
        where pr.id = p.user_id and pr.account_status = 'active'
          -- Teen shield (6A): minors' posts stay out of adults' discovery
          -- deck unless the admin setting opens it.
          and (pr.age_band = 'adult'
               or public.is_minor(auth.uid())
               or public.setting_numeric('teen_posts_in_adult_deck', 0) = 1)
      )
      -- Sensitive tier (6B): hidden entirely for minors; adults get it
      -- blurred client-side via the sensitive flag.
      and (not p.sensitive or not public.is_minor(auth.uid()))
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
  -- Part 5B: active boosts matching this (adult) viewer, least-served first.
  boosted as (
    select b.*, bo.id as boost_id
    from public.boosts bo
    join base b on b.id = bo.post_id
    cross join viewer v
    where bo.status = 'active'
      and now() >= bo.starts_at and now() < bo.ends_at
      and v.age_band = 'adult'                       -- boosts NEVER reach minors
      and (cardinality(bo.age_bands) = 0 or v.band = any(bo.age_bands))
      and (bo.region_label is null or v.search_center_label = bo.region_label)
      and (cardinality(bo.tag_ids) = 0 or exists (
            select 1 from public.user_tags ut
            where ut.user_id = v.id and ut.weight > 0 and ut.tag_id = any(bo.tag_ids)))
    order by bo.served_impressions asc, random()
    limit (select boost_quota from cfg)
  ),
  -- Part 8: ONE ad per deal (the deck's ad slot — my_ad_frequency governs
  -- perceived cadence through the frequency cap and this single slot).
  -- eligible_ads enforces consent, 18+ targeting, hides, caps, budgets.
  ad_slot as (
    select ea.ad_id, ea.cta_label, ea.cta_url, ea.broad,
           p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption,
           p.alt_text, p.like_count, p.skip_count, p.comment_count, p.created_at,
           p.overlays, p.sensitive
    from public.eligible_ads(auth.uid()) ea
    join public.posts p on p.id = ea.post_id
    where not exists (select 1 from public.swipes sw
                      where sw.user_id = auth.uid() and sw.post_id = ea.post_id)
      and p.id <> all(_exclude)
    order by random()
    limit 1
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
      (greatest(b.like_count - coalesce(bc.bot_like_count, 0), 0) + 1.0)
        / (greatest(b.like_count - coalesce(bc.bot_like_count, 0), 0)
           + greatest(b.skip_count - coalesce(bc.bot_skip_count, 0), 0) + 2.0) as like_quality,
      coalesce(q.fast_skips, 0)::double precision
        / (coalesce(q.likes, 0) + coalesce(q.skips, 0) + 10.0) as fast_skip_rate,
      case when b.media_type = 'video'
           then coalesce(q.completions, 0)::double precision / (coalesce(q.video_views, 0) + 10.0)
           else 0.0 end as completion_rate,
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
    select * from diverse
    where affinity > 0
      and id not in (select id from boosted)
    order by score desc
    limit greatest(_limit - (select explore_quota from cfg)
                          - (select count(*) from boosted)::integer, 0)
  ),
  explore as (
    select e.* from (
      select d.*,
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
          and d0.id not in (select id from boosted)
      ) d
    ) e
    order by e.tag_rn asc, e.escore desc
    limit (select explore_quota from cfg)
  ),
  backfill as (
    select * from diverse
    where id not in (select id from matched)
      and id not in (select id from explore)
      and id not in (select id from boosted)
    order by score desc
    limit greatest(_limit - (select count(*) from matched)
                          - (select count(*) from explore)
                          - (select count(*) from boosted)::integer, 0)
  ),
  combined as (
    -- Part 8 ad insertion point: slots every my_ad_frequency() cards.
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false as is_boosted, sensitive,
           false as is_ad, null::uuid as ad_id, null::text as cta_label, null::text as cta_url, null::text as ad_reason
    from matched
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false, sensitive,
           false, null::uuid, null::text, null::text, null::text
    from explore
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false, sensitive,
           false, null::uuid, null::text, null::text, null::text
    from backfill
    union all
    -- Boosted cards keep their ORGANIC score (via ranked3) so a weak post
    -- still lands mid-deck; falling back to 0 for brand-new posts.
    select bo.id, bo.user_id, bo.media_url, bo.thumbnail_url, bo.media_type, bo.caption,
           bo.alt_text, bo.like_count, bo.skip_count, bo.comment_count, bo.created_at,
           bo.overlays, coalesce(r3.score, 0), true, bo.sensitive,
           false, null::uuid, null::text, null::text, null::text
    from boosted bo
    left join ranked3 r3 on r3.id = bo.id
    union all
    -- The ad: a fixed mid-deal score so it lands naturally, always labelled.
    select ad.id, ad.user_id, ad.media_url, ad.thumbnail_url, ad.media_type, ad.caption,
           ad.alt_text, ad.like_count, ad.skip_count, ad.comment_count, ad.created_at,
           ad.overlays, 0.5, false, ad.sensitive,
           true, ad.ad_id, ad.cta_label, ad.cta_url,
           case when ad.broad
                then 'This ad is shown broadly to people on Phixr — nothing about you was used.'
                else 'This ad matches your age group, area or interests. You consented to personalised ads — change this any time in Settings.'
           end
    from ad_slot ad
  )
  select
    c.id, c.user_id, c.media_url, c.thumbnail_url, c.media_type, c.caption,
    c.alt_text, c.like_count, c.skip_count, c.comment_count, c.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}') as tags,
    c.overlays,
    c.is_boosted,
    c.sensitive,
    c.is_ad, c.ad_id, c.cta_label, c.cta_url, c.ad_reason
  from combined c
  join public.profiles pr on pr.id = c.user_id
  left join public.post_tags pt on pt.post_id = c.id
  left join public.tags t on t.id = pt.tag_id
  group by
    c.id, c.user_id, c.media_url, c.thumbnail_url, c.media_type, c.caption,
    c.alt_text, c.like_count, c.skip_count, c.comment_count, c.created_at, c.score,
    c.overlays, c.is_boosted, c.sensitive, c.is_ad, c.ad_id, c.cta_label, c.cta_url, c.ad_reason,
    pr.handle, pr.display_name, pr.avatar_url
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
  select count(*) into _n from inserted;

  perform public._flag_bot_patterns(_uid);
  return _n;
end;
$fn$;
revoke all on function public.record_view_events(jsonb) from public, anon;
grant execute on function public.record_view_events(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Advertiser reporting (8E): everything the brief lists, bot-cleaned, with
-- the 50-person audience floor and MINORS EXCLUDED ENTIRELY from advertiser
-- data. Owner-only (the advertiser whose campaign owns the ad).
-- ---------------------------------------------------------------------------
create or replace function public.get_ad_report(_ad_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _floor integer := public.setting_numeric('min_aggregate_group_size', 50)::integer;
  _post uuid;
  _views bigint := 0; _quick bigint := 0; _dwell bigint := 0;
  _video bigint := 0; _comp bigint := 0;
  _likes integer; _skips integer; _total integer;
  _clicks integer; _spend bigint;
  _dropoff jsonb := '[]'::jsonb; _peak integer;
  _bands jsonb := '[]'::jsonb; _regions jsonb := '[]'::jsonb; _interests jsonb := '[]'::jsonb;
  _tip text; _like_rate numeric; _quick_rate numeric; _completion numeric;
  p public.posts;
begin
  select a.post_id into _post
  from public.ads a
  join public.ad_sets s on s.id = a.ad_set_id
  join public.campaigns c on c.id = s.campaign_id
  where a.id = _ad_id and c.account_id = auth.uid();
  if _post is null then
    raise exception 'not authorised';
  end if;
  select * into p from public.posts where id = _post;

  select greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0),
         greatest(p.skip_count - coalesce(bc.bot_skip_count, 0), 0)
    into _likes, _skips
  from (select 1) one
  left join public.post_bot_counts bc on bc.post_id = _post;
  _total := _likes + _skips;
  _like_rate := case when _total > 0 then _likes::numeric / _total end;

  select coalesce(sum(s.views),0), coalesce(sum(s.quick_skips),0), coalesce(sum(s.dwell_ms_sum),0),
         coalesce(sum(s.video_views),0), coalesce(sum(s.completions),0)
    into _views, _quick, _dwell, _video, _comp
  from public.post_daily_stats s where s.post_id = _post;
  _quick_rate := case when _views > 0 then _quick::numeric / _views end;
  _completion := case when _video > 0 then _comp::numeric / _video end;

  if _video > 0 then
    with stops as (
      select (kv.key)::integer as sec, sum((kv.value)::numeric)::bigint as n
      from public.post_daily_stats s, lateral jsonb_each_text(s.stop_positions) kv
      where s.post_id = _post group by 1
    ),
    curve as (
      select st.sec,
             (_video - coalesce(sum(st.n) over (order by st.sec rows between unbounded preceding and 1 preceding), 0))::bigint as watching,
             st.n
      from stops st
    )
    select coalesce(jsonb_agg(jsonb_build_object('sec', c2.sec, 'watching', c2.watching) order by c2.sec), '[]'::jsonb),
           (select c3.sec from curve c3 order by c3.n desc, c3.sec limit 1)
      into _dropoff, _peak
    from curve c2;
  end if;

  select count(*) into _clicks from public.ad_clicks k where k.ad_id = _ad_id;
  select coalesce(-sum(ch.amount_pence), 0) into _spend
  from public.ad_charges ch where ch.ad_id = _ad_id and ch.amount_pence < 0;

  -- Audience: ADULT likers only (minors never in advertiser data), 50-floor.
  with banded as (
    select case
             when extract(year from age((now() at time zone 'Europe/London')::date, pr.date_of_birth)) < 25 then '18-24'
             when extract(year from age((now() at time zone 'Europe/London')::date, pr.date_of_birth)) < 35 then '25-34'
             when extract(year from age((now() at time zone 'Europe/London')::date, pr.date_of_birth)) < 45 then '35-44'
             when extract(year from age((now() at time zone 'Europe/London')::date, pr.date_of_birth)) < 55 then '45-54'
             else '55+'
           end as band,
           pr.search_center_label as region, pr.id as uid
    from public.swipes sw
    join public.profiles pr on pr.id = sw.user_id
    where sw.post_id = _post and sw.direction = 'right'
      and pr.age_band = 'adult'
      and pr.date_of_birth is not null
  ),
  bc as (select band, count(*)::integer as n from banded group by band),
  bf as (select case when n >= _floor then band else 'Other' end as band, sum(n)::integer as n
         from bc group by 1),
  rc as (select region, count(*)::integer as n from banded where region is not null group by region),
  rf as (select case when n >= _floor then region else 'Other' end as region, sum(n)::integer as n
         from rc group by 1),
  ic as (select t.name as tag, count(distinct b.uid)::integer as n
         from banded b
         join public.user_tags ut on ut.user_id = b.uid and ut.weight > 0
         join public.tags t on t.id = ut.tag_id
         group by t.name having count(distinct b.uid) >= _floor
         order by 2 desc limit 5)
  select
    coalesce((select jsonb_agg(jsonb_build_object('band', band, 'likes', n) order by n desc) from bf), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('region', region, 'likes', n) order by n desc) from rf), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('tag', tag, 'likes', n) order by n desc) from ic), '[]'::jsonb)
    into _bands, _regions, _interests;

  _tip := public._pick_tip(_quick_rate, _completion, _like_rate, null, null);

  return jsonb_build_object(
    'views', _views,
    'right_swipes', _likes,
    'left_swipes', _skips,
    'like_rate', _like_rate,
    'quick_skip_rate', _quick_rate,
    'avg_dwell_ms', case when _views > 0 then round(_dwell::numeric / _views) end,
    'completion_rate', _completion,
    'dropoff', _dropoff,
    'dropoff_peak_sec', _peak,
    'clicks', _clicks,
    'spend_pence', _spend,
    'cost_per_like_pence', case when _likes > 0 then round(_spend::numeric / _likes, 1) end,
    'cost_per_click_pence', case when _clicks > 0 then round(_spend::numeric / _clicks, 1) end,
    'audience', jsonb_build_object('age_bands', _bands, 'regions', _regions, 'interests', _interests),
    'tip', _tip
  );
end;
$fn$;
revoke all on function public.get_ad_report(uuid) from public, anon, authenticated;
grant execute on function public.get_ad_report(uuid) to authenticated;
