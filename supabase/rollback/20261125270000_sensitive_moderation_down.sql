-- Rollback for 20261125270000_sensitive_moderation.
-- Restores Part 4/5 policies and serving fns (verbatim), removes the text
-- pass, strikes, sensitive/held columns and the new report/notification
-- types (rows using them are deleted so the narrower checks hold).
-- Roll THIS back before 20261125260000_teen_protections.

set search_path = public, extensions;

drop trigger if exists zz_posts_text_moderation on public.posts;
drop function if exists public.tg_posts_text_moderation();
drop trigger if exists zz_comments_text_moderation on public.comments;
drop function if exists public.tg_comments_text_moderation();
drop function if exists public.moderate_text(text);
drop table if exists public.moderation_terms;
drop function if exists public.active_strike_count(uuid);
drop table if exists public.user_strikes;

-- Policies back to Part 4 shapes.
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
drop policy comments_select on public.comments;
create policy comments_select on public.comments
  for select to authenticated
  using (
    not public.is_blocked_with(user_id)
    and exists (select 1 from public.posts p where p.id = post_id)
  );

-- Serving fns back to their previous bodies.
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
  is_boosted          boolean
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
           like_count, skip_count, comment_count, created_at, overlays, score, false as is_boosted
    from matched
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false
    from explore
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false
    from backfill
    union all
    -- Boosted cards keep their ORGANIC score (via ranked3) so a weak post
    -- still lands mid-deck; falling back to 0 for brand-new posts.
    select bo.id, bo.user_id, bo.media_url, bo.thumbnail_url, bo.media_type, bo.caption,
           bo.alt_text, bo.like_count, bo.skip_count, bo.comment_count, bo.created_at,
           bo.overlays, coalesce(r3.score, 0), true
    from boosted bo
    left join ranked3 r3 on r3.id = bo.id
  )
  select
    c.id, c.user_id, c.media_url, c.thumbnail_url, c.media_type, c.caption,
    c.alt_text, c.like_count, c.skip_count, c.comment_count, c.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}') as tags,
    c.overlays,
    c.is_boosted
  from combined c
  join public.profiles pr on pr.id = c.user_id
  left join public.post_tags pt on pt.post_id = c.id
  left join public.tags t on t.id = pt.tag_id
  group by
    c.id, c.user_id, c.media_url, c.thumbnail_url, c.media_type, c.caption,
    c.alt_text, c.like_count, c.skip_count, c.comment_count, c.created_at, c.score,
    c.overlays, c.is_boosted, pr.handle, pr.display_name, pr.avatar_url
  order by c.score desc
  limit _limit;
$fn$;
revoke all on function public.get_deck(integer, uuid[]) from public, anon;
grant execute on function public.get_deck(integer, uuid[]) to authenticated;

drop function if exists public.get_following_feed(integer, timestamptz);
create function public.get_following_feed(
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

create or replace function public.get_discover(_limit integer default 30)
returns table(id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text,
              caption text, alt_text text, like_count integer, skip_count integer,
              comment_count integer, created_at timestamptz, poster_handle text,
              poster_display_name text, poster_avatar_url text, tags text[])
language sql stable security definer set search_path = '' as $fn$
  with base as (
    select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption,
           p.alt_text, p.like_count, p.skip_count, p.comment_count, p.created_at
    from public.posts p
    where p.visibility = 'public' and p.moderation_status = 'approved' and p.user_id <> auth.uid()
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
           or (b.blocker_id = p.user_id and b.blocked_id = auth.uid())
      )
  ),
  ranked as (
    select b.*,
      coalesce((select sum(ut.weight) from public.post_tags pt
        join public.user_tags ut on ut.tag_id = pt.tag_id and ut.user_id = auth.uid()
        where pt.post_id = b.id), 0)::double precision as affinity,
      exp(-extract(epoch from (now() - b.created_at)) / (48.0 * 3600.0)) as recency,
      ln(2 + b.like_count) as heat
    from base b
  )
  select r.id, r.user_id, r.media_url, r.thumbnail_url, r.media_type, r.caption, r.alt_text,
    r.like_count, r.skip_count, r.comment_count, r.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}') as tags
  from ranked r
  join public.profiles pr on pr.id = r.user_id
  left join public.post_tags pt on pt.post_id = r.id
  left join public.tags t on t.id = pt.tag_id
  group by r.id, r.user_id, r.media_url, r.thumbnail_url, r.media_type, r.caption, r.alt_text,
    r.like_count, r.skip_count, r.comment_count, r.created_at, r.affinity, r.recency, r.heat,
    pr.handle, pr.display_name, pr.avatar_url
  order by (r.affinity * 3.0 + r.recency * 2.0 + r.heat * 1.5) desc
  limit greatest(_limit, 0);
$fn$;

create or replace function public.search_posts(_q text, _limit int default 24, _offset int default 0)
returns table (
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text, caption text,
  alt_text text, like_count int, skip_count int, comment_count int, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text, tags text[]
) language sql stable security definer set search_path = '' as $fn$
  with q as (select websearch_to_tsquery('english', coalesce(_q, '')) as tsq),
  matched as (
    select p.id, ts_rank(p.search_vector, (select tsq from q)) as rank, p.created_at, p.user_id
    from public.posts p
    where (select tsq from q) is not null
      and p.search_vector @@ (select tsq from q)
      and p.moderation_status = 'approved'
      and (
        p.visibility = 'public'
        or p.user_id = auth.uid()
        or exists (select 1 from public.follows f
                   where f.follower_id = auth.uid() and f.followee_id = p.user_id and f.status = 'accepted')
      )
      and not exists (select 1 from public.blocks b
                      where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
                         or (b.blocker_id = p.user_id and b.blocked_id = auth.uid()))
      and exists (select 1 from public.profiles pr where pr.id = p.user_id and pr.account_status = 'active')
  )
  select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption, p.alt_text,
    p.like_count, p.skip_count, p.comment_count, p.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}')
  from matched m
  join public.posts p on p.id = m.id
  join public.profiles pr on pr.id = p.user_id
  left join public.post_tags pt on pt.post_id = p.id
  left join public.tags t on t.id = pt.tag_id
  group by p.id, pr.handle, pr.display_name, pr.avatar_url, pr.points_balance, m.rank
  order by m.rank desc, pr.points_balance desc, p.created_at desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;
create or replace function public.search_posts_local(_q text, _limit int default 24, _offset int default 0)
returns table (
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text, caption text,
  alt_text text, like_count int, skip_count int, comment_count int, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text, tags text[]
) language sql stable security definer set search_path = '' as $fn$
  with me as (
    select coalesce(search_center_location, search_location) as centre, search_radius_miles as radius
    from public.profiles where id = auth.uid()
  ),
  cells as (
    select public.local_cells(
      extensions.st_y(centre::extensions.geometry),
      extensions.st_x(centre::extensions.geometry),
      radius * 1609.34) as arr
    from me where centre is not null
  ),
  q as (select websearch_to_tsquery('english', coalesce(_q, '')) as tsq),
  matched as (
    select p.id, ts_rank(p.search_vector, (select tsq from q)) as rank, p.created_at
    from public.posts p
    where (select tsq from q) is not null
      and p.search_vector @@ (select tsq from q)
      and p.location_cell is not null
      and p.location_cell = any(coalesce((select arr from cells), array[]::text[]))
      and p.moderation_status = 'approved'
      and (
        p.visibility = 'public'
        or p.user_id = auth.uid()
        or exists (select 1 from public.follows f
                   where f.follower_id = auth.uid() and f.followee_id = p.user_id and f.status = 'accepted')
      )
      and not exists (select 1 from public.blocks b
                      where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
                         or (b.blocker_id = p.user_id and b.blocked_id = auth.uid()))
      and exists (select 1 from public.profiles pr where pr.id = p.user_id and pr.account_status = 'active')
  )
  select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption, p.alt_text,
    p.like_count, p.skip_count, p.comment_count, p.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}')
  from matched m
  join public.posts p on p.id = m.id
  join public.profiles pr on pr.id = p.user_id
  left join public.post_tags pt on pt.post_id = p.id
  left join public.tags t on t.id = pt.tag_id
  group by p.id, pr.handle, pr.display_name, pr.avatar_url, pr.points_balance, m.rank
  order by m.rank desc, pr.points_balance desc, p.created_at desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;
create or replace function public.search_posts_by_tag(_name text, _limit int default 24, _offset int default 0)
returns table (
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text, caption text,
  alt_text text, like_count int, skip_count int, comment_count int, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text, tags text[]
) language sql stable security definer set search_path = '' as $fn$
  select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption, p.alt_text,
    p.like_count, p.skip_count, p.comment_count, p.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(at.name) filter (where at.name is not null), '{}')
  from public.tags tg
  join public.post_tags tpt on tpt.tag_id = tg.id
  join public.posts p on p.id = tpt.post_id
  join public.profiles pr on pr.id = p.user_id
  left join public.post_tags pt on pt.post_id = p.id
  left join public.tags at on at.id = pt.tag_id
  where tg.name = lower(_name)
    and p.moderation_status = 'approved'
    and (
      p.visibility = 'public'
      or p.user_id = auth.uid()
      or exists (select 1 from public.follows f
                 where f.follower_id = auth.uid() and f.followee_id = p.user_id and f.status = 'accepted')
    )
    and not exists (select 1 from public.blocks b
                    where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
                       or (b.blocker_id = p.user_id and b.blocked_id = auth.uid()))
    and exists (select 1 from public.profiles pr2 where pr2.id = p.user_id and pr2.account_status = 'active')
  group by p.id, pr.handle, pr.display_name, pr.avatar_url
  order by p.created_at desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;

alter table public.reports drop constraint reports_target_type_check;
delete from public.reports where target_type = 'message';
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('post', 'user', 'comment'));

delete from public.notifications where type = 'report_update';
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like'));

alter table public.comments drop column if exists held;
alter table public.posts drop column if exists sensitive;

delete from public.platform_settings where key in (
  'strike_expiry_days', 'strikes_hold_threshold', 'strikes_suspend_threshold');
