-- ============================================================================
-- 20261124100000_view_events_bot_detection  (Build brief Parts 1B + 1C)
--
-- 1B — watch-time tracking. One row per deck card SHOWN (not just swiped):
-- viewer, post, when it appeared, how long it was on screen, the swipe
-- direction ('none' = shown but never swiped — app backgrounded / deck left),
-- and for videos the playback position and whether it completed. The client
-- batches events and the id is CLIENT-GENERATED, so retries are idempotent
-- (`on conflict (id) do nothing`). Public, approved, not-your-own posts only —
-- enforced here, not in the client. Raw events are purged after
-- view_event_retention_days (Part 3 rolls them up into daily totals first).
--
-- 1C — bot / fake-engagement detection. No daily caps; patterns instead:
--   fast_run        last N swiped cards all under bot_min_watch_ms
--   regular_timing  a full window of swipes with machine-regular gaps
--   monotone_run    a long run of nothing but likes (or nothing but skips)
-- A single fast swipe NEVER flags anyone — every check needs a full run.
-- Flagged events still count for the swiper's own feed (the swipes table is
-- untouched) but are excluded from creator analytics, ranking quality, points
-- and advertiser data:
--   * post_bot_counts keeps per-post flagged like/skip totals in a table the
--     app roles cannot read (a farmer must never see which swipes we caught);
--     get_deck's Laplace quality now uses (counts − flagged counts).
--   * user_trust: each newly flagged event costs trust_flag_penalty points
--     from 100; below trust_review_threshold the account joins the fame-admin
--     review queue and record_swipe stops awarding points until reviewed.
--     trust_daily_recovery points return per clean day (pg_cron).
--
-- Re-emits (both based on the CURRENT definitions, with changes marked):
--   * record_swipe (from 20260808130000): the hard-coded 1s dwell gate becomes
--     the points_swipe_min_gap_ms setting, plus the trust gate.
--   * get_deck (from 20260808390000): quality uses bot-cleaned counts, and —
--     REGRESSION FIX — restores the account_status='active' and mutes
--     predicates that 20260801090000 added but 20260808100000 (and its
--     20260808390000 copy) silently dropped. Suspended/banned authors' posts
--     and muted authors could re-enter the deck; now they can't again.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.post_view_events (
  id                uuid primary key,          -- client-generated: the idempotency key
  viewer_id         uuid not null references public.profiles (id) on delete cascade,
  post_id           uuid not null references public.posts (id) on delete cascade,
  shown_at          timestamptz not null,
  dwell_ms          integer not null check (dwell_ms >= 0),
  direction         text not null check (direction in ('left', 'right', 'none')),
  video_position_ms integer check (video_position_ms >= 0),
  video_completed   boolean,
  flagged           boolean not null default false,
  flag_reasons      text[] not null default '{}',
  created_at        timestamptz not null default now()
);
comment on table public.post_view_events is
  'Raw per-card view events (Part 1B). Written only via record_view_events; rolled up daily in Part 3; purged after view_event_retention_days.';
create index post_view_events_viewer on public.post_view_events (viewer_id, shown_at desc);
create index post_view_events_post   on public.post_view_events (post_id, created_at desc);
create index post_view_events_purge  on public.post_view_events (created_at);
alter table public.post_view_events enable row level security;
revoke all on public.post_view_events from anon, authenticated;

-- Flagged like/skip totals per post, deliberately in their own table with NO
-- app-role access: on posts the table-level SELECT grant would expose the
-- columns, giving farmers a feedback channel on what gets caught.
create table public.post_bot_counts (
  post_id        uuid primary key references public.posts (id) on delete cascade,
  bot_like_count integer not null default 0,
  bot_skip_count integer not null default 0,
  updated_at     timestamptz not null default now()
);
alter table public.post_bot_counts enable row level security;
revoke all on public.post_bot_counts from anon, authenticated;

create table public.user_trust (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  score         numeric not null default 100 check (score between 0 and 100),
  flagged_count bigint not null default 0,
  last_flag_at  timestamptz,
  review_status text not null default 'none' check (review_status in ('none', 'queued', 'cleared')),
  reviewed_by   uuid references auth.users (id),
  reviewed_at   timestamptz,
  updated_at    timestamptz not null default now()
);
comment on table public.user_trust is
  'Per-user bot-trust score (starts 100). Never shown to the user. queued = in the fame-admin review queue; cleared = an admin vouched for the account.';
create index user_trust_queue on public.user_trust (score) where review_status = 'queued';
alter table public.user_trust enable row level security;
revoke all on public.user_trust from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Pattern flagging. Runs after each ingested batch, over the user's recent
-- events only. Every check requires a FULL run — a lone fast swipe can't flag.
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

-- ---------------------------------------------------------------------------
-- 3. Batched, idempotent ingest — the client's single write path.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. Scheduled jobs: 90-day raw-event purge, daily trust recovery.
-- ---------------------------------------------------------------------------
create or replace function public.purge_view_events()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  delete from public.post_view_events
  where created_at < now() - make_interval(
    days => public.setting_numeric('view_event_retention_days', 90)::integer);
end;
$fn$;
revoke all on function public.purge_view_events() from public, anon, authenticated;

create or replace function public.trust_recovery()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _recover   numeric := public.setting_numeric('trust_daily_recovery', 5);
  _threshold numeric := public.setting_numeric('trust_review_threshold', 40);
begin
  update public.user_trust
  set score = least(100, score + _recover), updated_at = now()
  where score < 100
    and (last_flag_at is null or last_flag_at < now() - interval '24 hours');

  -- An account that recovered above the threshold before review leaves the
  -- queue by itself; 'cleared' (admin vouched) is never touched.
  update public.user_trust
  set review_status = 'none', updated_at = now()
  where review_status = 'queued' and score >= _threshold;
end;
$fn$;
revoke all on function public.trust_recovery() from public, anon, authenticated;

select cron.schedule('view-events-purge', '45 3 * * *', $$select public.purge_view_events();$$)
  where not exists (select 1 from cron.job where jobname = 'view-events-purge');
select cron.schedule('trust-recovery', '30 3 * * *', $$select public.trust_recovery();$$)
  where not exists (select 1 from cron.job where jobname = 'trust-recovery');

-- ---------------------------------------------------------------------------
-- 5. record_swipe re-emit (body from 20260808130000_points_economy).
-- Changes: (a) the dwell gate's hard-coded 1 second becomes the
-- points_swipe_min_gap_ms setting; (b) accounts in the bot-review zone
-- (trust below threshold / queued) earn nothing until reviewed.
-- ---------------------------------------------------------------------------
create or replace function public.record_swipe(_post_id uuid, _direction text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _inserted integer;
  _balance  bigint;
  _last     timestamptz;
  _dwell_ok boolean;
  _trusted  boolean;
  _lc       integer;
  _upto     integer;
  _owner    uuid;
  _buckets  integer;
begin
  if _direction not in ('left', 'right') then
    raise exception 'record_swipe: direction must be left or right';
  end if;

  -- Dwell gate: how long since this user's previous swipe? (captured BEFORE inserting)
  select max(created_at) into _last from public.swipes where user_id = auth.uid();
  _dwell_ok := (_last is null or now() - _last >= make_interval(
    secs => public.setting_numeric('points_swipe_min_gap_ms', 1000) / 1000.0));

  -- Trust gate (Part 1C): flagged-pattern accounts earn nothing until reviewed.
  select not exists (
    select 1 from public.user_trust t
    where t.user_id = auth.uid()
      and (t.score < public.setting_numeric('trust_review_threshold', 40)
           or t.review_status = 'queued')
  ) into _trusted;

  insert into public.swipes (user_id, post_id, direction)
  values (auth.uid(), _post_id, _direction)
  on conflict (user_id, post_id) do nothing;
  get diagnostics _inserted = row_count;

  if _inserted > 0 then
    -- Points are best-effort: a subtransaction so ANY points error is swallowed and
    -- can NEVER roll back the swipe itself (the swipe is the core flow).
    begin
      -- Swiper earns only if they actually looked (no rapid-fire / bot farming).
      if _dwell_ok and _trusted then
        _balance := public.award_points('swipe', 'swipe', _post_id);
      else
        select points_balance into _balance from public.profiles where id = auth.uid();
      end if;

      -- Batched creator reward on likes. like_count was just bumped by the AFTER-INSERT
      -- trigger. Award +3 per completed group of 10, referencing the POST only.
      if _direction = 'right' then
        select p.like_count, p.likes_rewarded_upto, p.user_id
          into _lc, _upto, _owner
        from public.posts p where p.id = _post_id;
        _buckets := (_lc / 10) - (_upto / 10);
        if _buckets > 0 and _owner is not null and _owner <> auth.uid() then
          perform public._award_to(_owner, _buckets * 3, 'like_milestone', 'post', _post_id);
          update public.posts set likes_rewarded_upto = _lc where id = _post_id;
        end if;
      end if;
    exception when others then
      select points_balance into _balance from public.profiles where id = auth.uid();
    end;
  else
    select points_balance into _balance from public.profiles where id = auth.uid();
  end if;

  return _balance;
end;
$fn$;
revoke all on function public.record_swipe(uuid, text) from public, anon;
grant execute on function public.record_swipe(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. get_deck re-emit (body from 20260808390000_post_overlays).
-- Changes: (a) Laplace quality now uses bot-cleaned counts via post_bot_counts
-- (greatest(…,0) because an undone swipe decrements like_count but the bot
-- counter keeps history); (b) REGRESSION FIX — the account_status and mutes
-- predicates from 20260801090000 are restored (dropped by 20260808100000).
-- Return signature unchanged.
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
