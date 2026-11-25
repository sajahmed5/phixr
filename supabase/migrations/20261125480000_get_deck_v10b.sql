-- Part 13: get_deck v10-b. Verbatim v10 (20261125370000) with the ad slot
-- carrying eligible_ads v2's audience kind + brand-safety fields, and the
-- "why this ad" text extended honestly for engaged/similar audiences. The
-- client uses ad_kind/ad_avoid_sensitive/ad_blocked_* to arrange the deck
-- (ad never adjacent to sensitive cards; per-ad topic/creator adjacency).

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
  ad_reason           text,
  ad_kind             text,
  ad_avoid_sensitive  boolean,
  ad_blocked_topics   text[],
  ad_blocked_creators uuid[]
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
      public.setting_numeric('creator_fast_skip_penalty_max', 0.5) as cp_max,
      -- Part 10 cold start: a viewer with no learned interests yet ranks
      -- admin-featured starter creators first in explore and backfill.
      (select count(*) = 0 from public.user_tags ut
        where ut.user_id = auth.uid() and ut.weight > 0)           as new_viewer,
      public.setting_numeric('featured_creator_boost', 3)          as featured_boost
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
    select ea.ad_id, ea.cta_label, ea.cta_url, ea.kind,
           ea.avoid_sensitive, ea.blocked_topics, ea.blocked_creators,
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
  -- Part 10 perf: affinity precomputed as one grouped join instead of a
  -- correlated subquery per candidate (same numbers, ~10x less work at 10k
  -- posts — 300ms → see launch summary).
  aff as (
    select pt.post_id, sum(ut.weight)::double precision as w
    from public.post_tags pt
    join public.user_tags ut on ut.tag_id = pt.tag_id and ut.user_id = auth.uid()
    group by pt.post_id
  ),
  ranked as (
    select b.*,
      coalesce(aff.w, 0)::double precision as affinity,
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
    left join aff on aff.post_id = b.id
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
            + case when (select new_viewer from cfg)
                    and exists (select 1 from public.featured_creators fc
                                where fc.user_id = d0.user_id and fc.active)
                   then (select featured_boost from cfg) else 0.0 end
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
    order by (score
      + case when (select new_viewer from cfg)
              and exists (select 1 from public.featured_creators fc
                          where fc.user_id = diverse.user_id and fc.active)
             then (select featured_boost from cfg) else 0.0 end) desc
    limit greatest(_limit - (select count(*) from matched)
                          - (select count(*) from explore)
                          - (select count(*) from boosted)::integer, 0)
  ),
  combined as (
    -- Part 8 ad insertion point: slots every my_ad_frequency() cards.
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false as is_boosted, sensitive,
           false as is_ad, null::uuid as ad_id, null::text as cta_label, null::text as cta_url, null::text as ad_reason,
           null::text as ad_kind, null::boolean as ad_avoid_sensitive,
           null::text[] as ad_blocked_topics, null::uuid[] as ad_blocked_creators
    from matched
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false, sensitive,
           false, null::uuid, null::text, null::text, null::text,
           null::text, null::boolean, null::text[], null::uuid[]
    from explore
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false, sensitive,
           false, null::uuid, null::text, null::text, null::text,
           null::text, null::boolean, null::text[], null::uuid[]
    from backfill
    union all
    -- Boosted cards keep their ORGANIC score (via ranked3) so a weak post
    -- still lands mid-deck; falling back to 0 for brand-new posts.
    select bo.id, bo.user_id, bo.media_url, bo.thumbnail_url, bo.media_type, bo.caption,
           bo.alt_text, bo.like_count, bo.skip_count, bo.comment_count, bo.created_at,
           bo.overlays, coalesce(r3.score, 0), true, bo.sensitive,
           false, null::uuid, null::text, null::text, null::text,
           null::text, null::boolean, null::text[], null::uuid[]
    from boosted bo
    left join ranked3 r3 on r3.id = bo.id
    union all
    -- The ad: a fixed mid-deal score so it lands naturally, always labelled.
    select ad.id, ad.user_id, ad.media_url, ad.thumbnail_url, ad.media_type, ad.caption,
           ad.alt_text, ad.like_count, ad.skip_count, ad.comment_count, ad.created_at,
           ad.overlays, 0.5, false, ad.sensitive,
           true, ad.ad_id, ad.cta_label, ad.cta_url,
           case ad.kind
                when 'broad' then 'This ad is shown broadly to people on Phixr — nothing about you was used.'
                when 'engaged' then 'You''re seeing this because you liked posts from this brand before. You consented to personalised ads — change this any time in Settings.'
                when 'similar' then 'You''re seeing this because your interests are similar to people who liked posts from this brand. You consented to personalised ads — change this any time in Settings.'
                else 'This ad matches your age group, area or interests. You consented to personalised ads — change this any time in Settings.'
           end,
           ad.kind, ad.avoid_sensitive, ad.blocked_topics, ad.blocked_creators
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
    c.is_ad, c.ad_id, c.cta_label, c.cta_url, c.ad_reason,
    c.ad_kind, c.ad_avoid_sensitive, c.ad_blocked_topics, c.ad_blocked_creators
  from combined c
  join public.profiles pr on pr.id = c.user_id
  left join public.post_tags pt on pt.post_id = c.id
  left join public.tags t on t.id = pt.tag_id
  group by
    c.id, c.user_id, c.media_url, c.thumbnail_url, c.media_type, c.caption,
    c.alt_text, c.like_count, c.skip_count, c.comment_count, c.created_at, c.score,
    c.overlays, c.is_boosted, c.sensitive, c.is_ad, c.ad_id, c.cta_label, c.cta_url, c.ad_reason,
    c.ad_kind, c.ad_avoid_sensitive, c.ad_blocked_topics, c.ad_blocked_creators,
    pr.handle, pr.display_name, pr.avatar_url
  order by c.score desc
  limit _limit;
$fn$;

revoke all on function public.get_deck(integer, uuid[]) from public, anon;
grant execute on function public.get_deck(integer, uuid[]) to authenticated;
