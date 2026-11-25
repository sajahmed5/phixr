-- Rollback for 20261124100000_view_events_bot_detection.
-- Restores record_swipe (20260808130000) and get_deck (20260808390000) to
-- their previous definitions, unschedules the cron jobs, then drops the
-- Part 1B/1C functions and tables.
--
-- NOTE: restoring get_deck verbatim also restores the account_status/mutes
-- regression that migration fixed — this is a faithful rollback, not a keep.

set search_path = public, extensions;

-- 1. Cron jobs.
select cron.unschedule('view-events-purge')
  where exists (select 1 from cron.job where jobname = 'view-events-purge');
select cron.unschedule('trust-recovery')
  where exists (select 1 from cron.job where jobname = 'trust-recovery');

-- 2. record_swipe back to the 20260808130000 version (1s dwell gate, no trust gate).
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
  _lc       integer;
  _upto     integer;
  _owner    uuid;
  _buckets  integer;
begin
  if _direction not in ('left', 'right') then
    raise exception 'record_swipe: direction must be left or right';
  end if;

  select max(created_at) into _last from public.swipes where user_id = auth.uid();
  _dwell_ok := (_last is null or now() - _last >= interval '1 second');

  insert into public.swipes (user_id, post_id, direction)
  values (auth.uid(), _post_id, _direction)
  on conflict (user_id, post_id) do nothing;
  get diagnostics _inserted = row_count;

  if _inserted > 0 then
    begin
      if _dwell_ok then
        _balance := public.award_points('swipe', 'swipe', _post_id);
      else
        select points_balance into _balance from public.profiles where id = auth.uid();
      end if;

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

-- 3. get_deck back to the 20260808390000 version (verbatim).
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
      and not exists (
        select 1 from public.swipes s where s.user_id = auth.uid() and s.post_id = p.id
      )
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
           or (b.blocker_id = p.user_id and b.blocked_id = auth.uid())
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
      (b.like_count + 1.0) / (b.like_count + b.skip_count + 2.0) as quality,
      case
        when now() - pr.created_at < interval '14 days'
        then 2.0 * (1.0 - extract(epoch from (now() - pr.created_at)) / (14.0 * 86400.0))
        else 0.0
      end as newcomer_boost
    from base b
    join public.profiles pr on pr.id = b.user_id
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

-- 4. Functions.
drop function if exists public.record_view_events(jsonb);
drop function if exists public._flag_bot_patterns(uuid);
drop function if exists public.purge_view_events();
drop function if exists public.trust_recovery();

-- 5. Tables.
drop table if exists public.post_view_events;
drop table if exists public.post_bot_counts;
drop table if exists public.user_trust;
