-- Part 6B: moderation — sensitive tier, text first pass, strikes, reports.
--
-- What already existed (and is reused, not replaced): the media pipeline's
-- AI pass (vision reject/flag/approve) with pipeline_verdicts stamping
-- posts.moderation_status; the CSAM stub scanner with case refs + evidence
-- preservation + the fame-admin CSAM escalation page (THE hash-matching
-- hook: swap stubScanner for a PhotoDNA/IWF client without touching the
-- flow — documented in docs/csam-process.md); reports with categories and
-- the fame-admin queue; appeals; admin roles + append-only audit log.
--
-- Added here:
--   1. SENSITIVE tier: posts.sensitive — approved and visible, but blurred
--      for adults (client reads the flag) and NEVER served to minors
--      (RLS + every feed fn). Set by admins (review queue) or the text pass.
--   2. TEXT FIRST PASS (decided with Saj: rule-based now, provider hook
--      later): moderation_terms (admin-editable regex rules) + moderate_text.
--      Captions: ban -> refused with a kind message; flag -> post held
--      ('flagged', existing review flow); sensitive -> sensitive = true.
--      Comments: ban -> refused; flag -> comments.held = true (hidden from
--      everyone but the author until a human decides).
--      PROVIDER HOOK: point the media-pipeline edge function (or a new
--      moderate-text function) at a real classifier and write the same
--      verdicts; moderate_text stays as the cheap pre-filter.
--   3. STRIKES that expire: user_strikes + active_strike_count. At
--      strikes_hold_threshold active strikes every new post is held for
--      review (restriction); at strikes_suspend_threshold fame-admin shows
--      a suspension recommendation (suspension itself stays a human call).
--   4. REPORTS: 'message' target joins the list; resolving a report
--      notifies the reporter ('report_update' notification, sent by the
--      fame-admin action).
--   5. Teen + sensitive filters land in every serving fn (deck, friends
--      feed, discover, search). Minors' posts also leave adults' get_discover
--      (a discovery surface like the deck); plain text search keeps public
--      posts findable regardless of author age (deliberate: search is a
--      lookup, not a suggestion — revisit in Part 7 if Saj disagrees).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Columns + settings.
-- ---------------------------------------------------------------------------
alter table public.posts add column sensitive boolean not null default false;
alter table public.comments add column held boolean not null default false;

insert into public.platform_settings (key, value, description, client_visible) values
  ('strike_expiry_days',        '90'::jsonb, 'Days until a strike stops counting (brief 6B: strikes expire).', false),
  ('strikes_hold_threshold',    '2'::jsonb,  'Active strikes at which every new post is held for human review (the "restrictions" stage).', false),
  ('strikes_suspend_threshold', '3'::jsonb,  'Active strikes at which fame-admin recommends suspension (a human decides).', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Sensitive is invisible to minors everywhere RLS reaches (post page,
--    profile grids, comment existence). Owner still sees their own.
-- ---------------------------------------------------------------------------
drop policy posts_select on public.posts;
create policy posts_select on public.posts
  for select to authenticated
  using (
    user_id = auth.uid()
    or (
      not public.is_blocked_with(user_id)
      and moderation_status <> 'removed'
      and (not sensitive or not public.is_minor(auth.uid()))
      and (
        (visibility = 'public' and moderation_status = 'approved')
        or (visibility = 'private' and public.is_accepted_follower_of(user_id))
        or (visibility = 'groups'
            and public.is_accepted_follower_of(user_id)
            and public.viewer_in_post_groups(id))
      )
    )
  );

-- Held comments: only their author sees them until a human decides.
drop policy comments_select on public.comments;
create policy comments_select on public.comments
  for select to authenticated
  using (
    not public.is_blocked_with(user_id)
    and (not held or user_id = auth.uid())
    and exists (select 1 from public.posts p where p.id = post_id)
  );

-- ---------------------------------------------------------------------------
-- 3. The rule-based text pass.
-- ---------------------------------------------------------------------------
create table public.moderation_terms (
  id         uuid primary key default gen_random_uuid(),
  pattern    text not null,            -- case-insensitive regex
  verdict    text not null check (verdict in ('removed', 'flagged', 'sensitive')),
  category   text not null check (category in
               ('sexual', 'hate', 'terrorism', 'self_harm', 'illegal_goods', 'csam', 'other')),
  note       text,
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);
alter table public.moderation_terms enable row level security;
revoke all on table public.moderation_terms from public, anon, authenticated;

-- Deliberately conservative seeds: unambiguous terms only. Everything else
-- is for admins to tune in fame-admin (or the future AI provider).
insert into public.moderation_terms (pattern, verdict, category, note) values
  ('\mchild\s*porn\M',            'removed', 'csam',          'unambiguous'),
  ('\mcsam\M',                     'flagged', 'csam',          'review context'),
  ('\mkill\s+yourself\M',         'removed', 'self_harm',     'direct incitement'),
  ('\mkys\M',                      'flagged', 'self_harm',     'often abusive, review'),
  ('\mheil\s+hitler\M',           'removed', 'hate',          'unambiguous'),
  ('\m(buy|sell)\s+(cocaine|heroin|fentanyl)\M', 'removed', 'illegal_goods', 'unambiguous'),
  ('\mgraphic\s+(violence|injury|content)\M', 'sensitive', 'other', 'self-labelled graphic content');

create or replace function public.moderate_text(_t text)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  -- Worst verdict wins: removed > flagged > sensitive > approved.
  select coalesce((
    select mt.verdict
    from public.moderation_terms mt
    where mt.active and coalesce(_t, '') ~* mt.pattern
    order by case mt.verdict when 'removed' then 0 when 'flagged' then 1 else 2 end
    limit 1
  ), 'approved');
$fn$;
revoke all on function public.moderate_text(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Strikes.
-- ---------------------------------------------------------------------------
create table public.user_strikes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  reason     text not null,
  ref_type   text,
  ref_id     uuid,
  created_by uuid references auth.users (id),   -- null = automatic
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index user_strikes_active on public.user_strikes (user_id, expires_at);
alter table public.user_strikes enable row level security;
-- The struck user may see their own strikes (transparency); writes via admin.
create policy user_strikes_own on public.user_strikes
  for select to authenticated using (user_id = auth.uid());
revoke all on table public.user_strikes from public, anon, authenticated;
grant select on public.user_strikes to authenticated;

create or replace function public.active_strike_count(_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  select count(*)::integer from public.user_strikes s
  where s.user_id = _user and s.expires_at > now();
$fn$;
revoke all on function public.active_strike_count(uuid) from public, anon;
grant execute on function public.active_strike_count(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Caption pass + strike restriction on posts. ESCALATE-ONLY, and runs
--    after the pipeline verdict trigger (alphabetical order): it never
--    upgrades a removed/flagged post back to approved.
-- ---------------------------------------------------------------------------
create or replace function public.tg_posts_text_moderation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _verdict text;
begin
  _verdict := public.moderate_text(coalesce(new.caption, '') || ' ' || coalesce(new.alt_text, ''));
  if _verdict = 'removed' then
    raise exception 'That caption breaks our guidelines, so this can''t be posted. See the Community Guidelines for what''s allowed.';
  elsif _verdict = 'flagged' and new.moderation_status = 'approved' then
    new.moderation_status := 'flagged';
  elsif _verdict = 'sensitive' then
    new.sensitive := true;
  end if;

  -- Strike restriction (6B): at the hold threshold, everything is reviewed.
  if tg_op = 'INSERT'
     and new.moderation_status = 'approved'
     and public.active_strike_count(new.user_id)
         >= public.setting_numeric('strikes_hold_threshold', 2)::integer then
    new.moderation_status := 'flagged';
  end if;
  return new;
end;
$fn$;
revoke all on function public.tg_posts_text_moderation() from public, anon, authenticated;
create trigger zz_posts_text_moderation
  before insert or update of caption, alt_text on public.posts
  for each row execute function public.tg_posts_text_moderation();

-- ---------------------------------------------------------------------------
-- 6. Reports: messages are reportable; reporters hear back.
-- ---------------------------------------------------------------------------
alter table public.reports drop constraint reports_target_type_check;
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('post', 'user', 'comment', 'message'));

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update'));

-- ---------------------------------------------------------------------------
-- 7. Comment pass: ban refused kindly; borderline held for review.
--    (add_comment inserts the row, so a BEFORE INSERT trigger covers both
--    the RPC and any future path.)
-- ---------------------------------------------------------------------------
create or replace function public.tg_comments_text_moderation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _verdict text := public.moderate_text(new.body);
begin
  if _verdict = 'removed' then
    raise exception 'That comment breaks our guidelines, so it can''t be posted.';
  elsif _verdict = 'flagged' then
    new.held := true;
  end if;
  return new;
end;
$fn$;
revoke all on function public.tg_comments_text_moderation() from public, anon, authenticated;
create trigger zz_comments_text_moderation
  before insert on public.comments
  for each row execute function public.tg_comments_text_moderation();

-- ---------------------------------------------------------------------------
-- 8. Serving functions: teen + sensitive rules everywhere.
-- ---------------------------------------------------------------------------
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
  sensitive           boolean
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
           like_count, skip_count, comment_count, created_at, overlays, score, false as is_boosted, sensitive
    from matched
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false, sensitive
    from explore
    union all
    select id, user_id, media_url, thumbnail_url, media_type, caption, alt_text,
           like_count, skip_count, comment_count, created_at, overlays, score, false, sensitive
    from backfill
    union all
    -- Boosted cards keep their ORGANIC score (via ranked3) so a weak post
    -- still lands mid-deck; falling back to 0 for brand-new posts.
    select bo.id, bo.user_id, bo.media_url, bo.thumbnail_url, bo.media_type, bo.caption,
           bo.alt_text, bo.like_count, bo.skip_count, bo.comment_count, bo.created_at,
           bo.overlays, coalesce(r3.score, 0), true, bo.sensitive
    from boosted bo
    left join ranked3 r3 on r3.id = bo.id
  )
  select
    c.id, c.user_id, c.media_url, c.thumbnail_url, c.media_type, c.caption,
    c.alt_text, c.like_count, c.skip_count, c.comment_count, c.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}') as tags,
    c.overlays,
    c.is_boosted,
    c.sensitive
  from combined c
  join public.profiles pr on pr.id = c.user_id
  left join public.post_tags pt on pt.post_id = c.id
  left join public.tags t on t.id = pt.tag_id
  group by
    c.id, c.user_id, c.media_url, c.thumbnail_url, c.media_type, c.caption,
    c.alt_text, c.like_count, c.skip_count, c.comment_count, c.created_at, c.score,
    c.overlays, c.is_boosted, c.sensitive, pr.handle, pr.display_name, pr.avatar_url
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
  my_feed_like boolean, overlays jsonb, sensitive boolean
) language sql stable security definer set search_path = '' as $fn$
  with base as (
    select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption,
           p.alt_text, p.like_count, p.skip_count, p.feed_like_count, p.comment_count,
           p.created_at, p.overlays, p.sensitive
    from public.posts p
    join public.follows f
      on f.followee_id = p.user_id and f.follower_id = auth.uid() and f.status = 'accepted'
    where p.moderation_status = 'approved'
      and (p.visibility in ('public', 'private')
           or (p.visibility = 'groups' and public.viewer_in_post_groups(p.id)))
      and p.user_id <> auth.uid()
      and (not p.sensitive or not public.is_minor(auth.uid()))
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
    b.overlays, b.sensitive
  from base b
  join public.profiles pr on pr.id = b.user_id
  left join public.post_likes pl on pl.post_id = b.id and pl.user_id = auth.uid()
  left join public.post_tags pt on pt.post_id = b.id
  left join public.tags t on t.id = pt.tag_id
  group by b.id, b.user_id, b.media_url, b.thumbnail_url, b.media_type, b.caption, b.alt_text,
    b.like_count, b.skip_count, b.feed_like_count, b.comment_count, b.created_at, b.overlays, b.sensitive,
    pr.handle, pr.display_name, pr.avatar_url, pl.user_id
  order by b.created_at desc
  limit greatest(_limit, 0);
$fn$;

-- get_discover: a discovery surface — minors' posts leave adults' view, and
-- sensitive posts leave the grid entirely (thumbnail grids don't blur).
create or replace function public.get_discover(_limit integer default 30)
returns table(id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text,
              caption text, alt_text text, like_count integer, skip_count integer,
              comment_count integer, created_at timestamptz, poster_handle text,
              poster_display_name text, poster_avatar_url text, tags text[])
language sql
stable
security definer
set search_path = ''
as $fn$
  with base as (
    select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption,
           p.alt_text, p.like_count, p.skip_count, p.comment_count, p.created_at
    from public.posts p
    where p.visibility = 'public' and p.moderation_status = 'approved' and p.user_id <> auth.uid()
      and not p.sensitive
      and exists (select 1 from public.profiles pra
                  where pra.id = p.user_id
                    and (pra.age_band = 'adult'
                         or public.is_minor(auth.uid())
                         or public.setting_numeric('teen_posts_in_adult_deck', 0) = 1))
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

-- search_posts / search_posts_local / search_posts_by_tag: sensitive posts
-- leave all search grids (thumbnails can't blur; Part 7A will rework these).
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
      and not p.sensitive  -- 6B: sensitive stays out of search grids
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
      and not p.sensitive  -- 6B: sensitive stays out of search grids
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
      and not p.sensitive  -- 6B: sensitive stays out of search grids
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
