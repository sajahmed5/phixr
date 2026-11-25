-- Part 5B: boosts — one system for everyone, paid with points (phase 1).
--
-- DECIDED WITH SAJ (2026-11-25): Apple/Google in-app purchase lands in a
-- follow-up (needs a native module → new TestFlight build + store products
-- Saj must configure). The schema carries money columns and a provider field
-- from day one so the IAP phase only adds a payment path, not a redesign.
--
-- Mechanics:
--   * A boost runs a public, approved post for N days to a chosen audience
--     (adult age bands, area label, interest tags — empty means "any adult").
--   * Cost = days × boost_points_per_day (settings). Deducted up front
--     ('boost_purchase' ledger entry); cancelling refunds unused whole days.
--   * The deck (v5) reserves a rotating slot: roughly one card per
--     boost_slot_one_in dealt cards goes to the active, viewer-matching
--     boost that has been seen the least. Cards carry is_boosted and the
--     app labels them "Boosted".
--   * Boosted posts KEEP every quality/safety mechanism: moderation gates,
--     bot-cleaned counts, quick-skip penalties — paying never overrides
--     quality (the slot only grants presence, not ranking immunity, and a
--     boost on a post that loses approval simply stops matching).
--   * Under-18s can't buy boosts; boosts only ever serve to adult viewers.
--   * served_impressions counts REAL tracked views (bot-excluded at ingest),
--     bumped by record_view_events — the deck function stays read-only.
--   * Results: get_my_boosts reports views/likes in the boost window from
--     the Part 3 roll-ups, and points per like.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Settings.
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description, client_visible) values
  ('boost_points_per_day',      '100'::jsonb, 'Points cost per day of boosting a post.', true),
  ('boost_max_days',            '7'::jsonb,   'Longest boost a creator can buy in one go.', true),
  ('boost_slot_one_in',         '8'::jsonb,   'Deck deal reserves ~one boosted card per this many cards when an eligible boost matches the viewer.', false),
  ('boost_est_reach_share',     '0.3'::jsonb, 'Fraction of the matching audience a boost is estimated to reach per day (reach-estimate heuristic shown before purchase).', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The boosts table.
-- ---------------------------------------------------------------------------
create table public.boosts (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.posts (id) on delete cascade,
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  status        text not null default 'active' check (status in ('active', 'ended', 'cancelled')),
  -- Audience (empty array / null = any adult). NEVER minors: the deck only
  -- serves boosts to adult viewers regardless of what is stored here.
  age_bands     text[] not null default '{}',   -- e.g. {18-24,25-34}
  region_label  text,                           -- matches profiles.search_center_label
  tag_ids       uuid[] not null default '{}',   -- interest targeting
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz not null,
  days          integer not null check (days > 0),
  points_cost   integer not null check (points_cost >= 0),
  -- Phase 2 (IAP): money part of a mixed payment. 0 until then.
  money_pence   integer not null default 0 check (money_pence >= 0),
  provider      text not null default 'points' check (provider in ('points', 'apple', 'google', 'mixed')),
  served_impressions integer not null default 0,
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz
);
create index boosts_active on public.boosts (status, ends_at);
create index boosts_post on public.boosts (post_id);
create index boosts_owner on public.boosts (owner_id, created_at desc);

alter table public.boosts enable row level security;
-- Owners read their own boosts; all writes go through the RPCs below.
create policy boosts_owner_select on public.boosts
  for select to authenticated
  using (owner_id = auth.uid());
revoke all on table public.boosts from public, anon, authenticated;
grant select on public.boosts to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Reach estimate — shown BEFORE confirming. A labelled estimate, not a
--    promise: matching adult accounts, and a settings-driven daily share.
-- ---------------------------------------------------------------------------
create or replace function public.estimate_boost_reach(
  _age_bands text[] default '{}',
  _region_label text default null,
  _tag_ids uuid[] default '{}'
)
returns table (audience_size integer, est_daily_views integer)
language sql
stable
security definer
set search_path = ''
as $fn$
  with aud as (
    select count(*)::integer as n
    from public.profiles pr
    cross join lateral (
      select case
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
    ) b
    where pr.age_band = 'adult'          -- never minors, ever
      and pr.account_status = 'active'
      and pr.id <> auth.uid()
      and (cardinality(_age_bands) = 0 or b.band = any(_age_bands))
      and (_region_label is null or pr.search_center_label = _region_label)
      and (cardinality(_tag_ids) = 0 or exists (
            select 1 from public.user_tags ut
            where ut.user_id = pr.id and ut.weight > 0 and ut.tag_id = any(_tag_ids)))
  )
  select a.n,
         ceil(a.n * public.setting_numeric('boost_est_reach_share', 0.3))::integer
  from aud a;
$fn$;
revoke all on function public.estimate_boost_reach(text[], text, uuid[])
  from public, anon, authenticated;
grant execute on function public.estimate_boost_reach(text[], text, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Buying and cancelling.
-- ---------------------------------------------------------------------------
create or replace function public.create_boost(
  _post_id uuid,
  _days integer,
  _age_bands text[] default '{}',
  _region_label text default null,
  _tag_ids uuid[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid uuid := auth.uid();
  _per_day integer := public.setting_numeric('boost_points_per_day', 100)::integer;
  _max_days integer := public.setting_numeric('boost_max_days', 7)::integer;
  _cost integer;
  _balance bigint;
  _id uuid;
begin
  if _uid is null then raise exception 'create_boost: not authenticated'; end if;
  if _days < 1 or _days > _max_days then
    raise exception 'create_boost: days must be between 1 and %', _max_days;
  end if;
  -- Under-18s can't buy boosts (brief 5B).
  if exists (select 1 from public.profiles pr where pr.id = _uid and pr.age_band = 'minor') then
    raise exception 'create_boost: not available for under-18 accounts';
  end if;
  -- Only your own public, approved posts. Group/followers posts can't be
  -- boosted (they are not deck material).
  if not exists (
    select 1 from public.posts p
    where p.id = _post_id and p.user_id = _uid
      and p.visibility = 'public' and p.moderation_status = 'approved'
  ) then
    raise exception 'create_boost: post not eligible';
  end if;
  if exists (select 1 from public.boosts b
             where b.post_id = _post_id and b.status = 'active' and b.ends_at > now()) then
    raise exception 'create_boost: post already boosted';
  end if;
  -- All stored bands must be adult bands.
  if exists (select 1 from unnest(_age_bands) ab
             where ab not in ('18-24','25-34','35-44','45-54','55+')) then
    raise exception 'create_boost: bad age band';
  end if;

  _cost := _days * _per_day;
  select points_balance into _balance from public.profiles where id = _uid;
  if _balance < _cost then
    raise exception 'create_boost: not enough points (need %, have %)', _cost, _balance;
  end if;

  insert into public.boosts (post_id, owner_id, age_bands, region_label, tag_ids,
                             ends_at, days, points_cost)
  values (_post_id, _uid, coalesce(_age_bands, '{}'), nullif(btrim(coalesce(_region_label, '')), ''),
          coalesce(_tag_ids, '{}'), now() + make_interval(days => _days), _days, _cost)
  returning id into _id;

  perform public._award_to(_uid, -_cost, 'boost_purchase', 'boost', _id);
  return _id;
end;
$fn$;
revoke all on function public.create_boost(uuid, integer, text[], text, uuid[])
  from public, anon, authenticated;
grant execute on function public.create_boost(uuid, integer, text[], text, uuid[]) to authenticated;

create or replace function public.cancel_boost(_boost_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid uuid := auth.uid();
  b public.boosts;
  _unused_days integer;
  _refund integer;
begin
  select * into b from public.boosts where id = _boost_id and owner_id = _uid;
  if not found then raise exception 'cancel_boost: not your boost'; end if;
  if b.status <> 'active' or b.ends_at <= now() then
    raise exception 'cancel_boost: boost is not running';
  end if;

  _unused_days := floor(extract(epoch from (b.ends_at - now())) / 86400.0)::integer;
  _refund := _unused_days * (b.points_cost / b.days);

  update public.boosts
     set status = 'cancelled', cancelled_at = now(), ends_at = now()
   where id = _boost_id;
  if _refund > 0 then
    perform public._award_to(_uid, _refund, 'boost_refund', 'boost', _boost_id);
  end if;
end;
$fn$;
revoke all on function public.cancel_boost(uuid) from public, anon, authenticated;
grant execute on function public.cancel_boost(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Results for the dashboard: window views/likes from the roll-ups and
--    points per like. Owner-only via RLS + the owner filter here.
-- ---------------------------------------------------------------------------
create or replace function public.get_my_boosts(_limit integer default 20)
returns table (
  id uuid, post_id uuid, status text, starts_at timestamptz, ends_at timestamptz,
  days integer, points_cost integer, age_bands text[], region_label text,
  served_impressions integer,
  window_views bigint, window_likes bigint, points_per_like numeric,
  thumbnail_url text, media_type text, caption text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select b.id, b.post_id, b.status, b.starts_at, b.ends_at, b.days, b.points_cost,
         b.age_bands, b.region_label, b.served_impressions,
         coalesce(w.views, 0), coalesce(w.likes, 0),
         case when coalesce(w.likes, 0) > 0
              then round(b.points_cost::numeric / w.likes, 1) end,
         p.thumbnail_url, p.media_type, p.caption
  from public.boosts b
  join public.posts p on p.id = b.post_id
  left join lateral (
    select sum(s.views) as views, sum(s.right_swipes) as likes
    from public.post_daily_stats s
    where s.post_id = b.post_id
      and s.day >= (b.starts_at at time zone 'Europe/London')::date
      and s.day <= (b.ends_at   at time zone 'Europe/London')::date
  ) w on true
  where b.owner_id = auth.uid()
  order by b.created_at desc
  limit greatest(_limit, 0);
$fn$;
revoke all on function public.get_my_boosts(integer) from public, anon, authenticated;
grant execute on function public.get_my_boosts(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Housekeeping: mark expired boosts ended (piggybacks the 15-min cadence).
-- ---------------------------------------------------------------------------
create or replace function public.end_expired_boosts()
returns void
language sql
security definer
set search_path = ''
as $fn$
  update public.boosts set status = 'ended'
  where status = 'active' and ends_at <= now();
$fn$;
revoke all on function public.end_expired_boosts() from public, anon, authenticated;

select cron.schedule('boosts-expire', '11,26,41,56 * * * *',
                     $$select public.end_expired_boosts();$$)
where not exists (select 1 from cron.job where jobname = 'boosts-expire');
