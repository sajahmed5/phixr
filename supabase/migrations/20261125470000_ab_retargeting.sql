-- Part 13B/13C/13D: A/B testing, retargeting + similar audiences, brand
-- safety preferences.
--
-- 13C PRIVACY: engaged/similar audiences are matched at SERVING time, so
-- the advertiser never holds a list of people; sets below the 50-person
-- floor can't be activated (validate_ad_set_audience stamps them); the
-- consent wall (adults + personalised consent) applies in full, and the
-- user-facing "why am I seeing this" names the reason honestly.

insert into public.platform_settings (key, value, description, client_visible) values
  ('ab_min_views_per_variant', to_jsonb(100), 'Views each A/B version needs before a winner can be declared.', false),
  ('similar_top_tags', to_jsonb(5), 'How many of the engaged audience''s top interests define a similar audience.', false)
on conflict (key) do nothing;

-- Audience kinds + brand safety on ad sets.
alter table public.ad_sets
  add column audience_kind text not null default 'standard'
    check (audience_kind in ('standard', 'engaged', 'similar')),
  add column engaged_days integer not null default 90
    check (engaged_days in (30, 60, 90)),
  add column audience_validated_at timestamptz,
  add column avoid_sensitive boolean not null default true,
  add column blocked_topics text[] not null default '{}',
  add column blocked_creators uuid[] not null default '{}';

-- Activation gate for engaged/similar sets: the CURRENT audience must clear
-- the aggregate floor. Only a count is computed; nothing about WHO is ever
-- returned to the advertiser.
create or replace function public.validate_ad_set_audience(_ad_set_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s record;
  _floor integer := public.setting_numeric('min_aggregate_group_size', 50)::integer;
  _n integer;
begin
  select st.audience_kind, st.engaged_days, c.account_id as biz into s
  from public.ad_sets st join public.campaigns c on c.id = st.campaign_id
  where st.id = _ad_set_id;
  if s.biz is null or not public.has_team_role(s.biz, array['admin','editor']) then
    raise exception 'not authorised';
  end if;
  if s.audience_kind = 'standard' then return null; end if;

  select count(distinct sw.user_id) into _n
  from public.swipes sw
  join public.posts ep on ep.id = sw.post_id
  join public.profiles pr on pr.id = sw.user_id
  where ep.user_id = s.biz and sw.direction = 'right'
    and sw.created_at > now() - make_interval(days => s.engaged_days)
    and pr.age_band = 'adult' and pr.ads_consent = 'personalised';

  if _n < _floor then
    update public.ad_sets set audience_validated_at = null where id = _ad_set_id;
    raise exception 'This audience has fewer than % people, so it can''t be used.', _floor;
  end if;
  update public.ad_sets set audience_validated_at = now() where id = _ad_set_id;
  return _n;  -- a single rounded count, never who
end;
$$;

-- ---------------------------------------------------------------------------
-- 13B: A/B tests (2–4 versions inside one ad set; the deck's random pick
-- among a set's active ads gives the even split).
-- ---------------------------------------------------------------------------
create table public.ad_tests (
  id         uuid primary key default gen_random_uuid(),
  ad_set_id  uuid not null references public.ad_sets (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  status     text not null default 'running' check (status in ('running', 'ended')),
  winner_ad_id uuid references public.ads (id) on delete set null,
  created_at timestamptz not null default now(),
  ended_at   timestamptz
);
alter table public.ad_tests enable row level security;
revoke all on table public.ad_tests from public, anon, authenticated;
grant select, insert, update on table public.ad_tests to authenticated;
create policy ad_tests_team on public.ad_tests
  for all to authenticated
  using (exists (select 1 from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
                 where s.id = ad_set_id
                 and public.has_team_role(c.account_id, array['admin','editor','analyst','moderator'])))
  with check (exists (select 1 from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
                 where s.id = ad_set_id
                 and public.has_team_role(c.account_id, array['admin','editor'])));

alter table public.ads
  add column test_id uuid references public.ad_tests (id) on delete set null,
  add column variant_label text check (variant_label is null or char_length(variant_label) <= 20);

-- Plain-English A/B report with a confidence level and a verdict only once
-- every variant clears the minimum-data setting.
create or replace function public.get_ad_test_report(_test_id uuid)
returns jsonb
language plpgsql
volatile  -- builds a temp working table
security definer
set search_path = ''
as $$
declare
  _biz uuid;
  _min integer := public.setting_numeric('ab_min_views_per_variant', 100)::integer;
  _variants jsonb;
  _ready boolean;
  _best record;
  _second record;
  _z numeric;
  _conf text := 'low';
  _verdict text;
  _p numeric; _lift numeric;
begin
  select c.account_id into _biz
  from public.ad_tests t
  join public.ad_sets s on s.id = t.ad_set_id
  join public.campaigns c on c.id = s.campaign_id
  where t.id = _test_id;
  if _biz is null or not public.has_team_role(_biz, array['admin','editor','analyst','moderator']) then
    raise exception 'not authorised';
  end if;

  drop table if exists _ab;
  create temp table _ab on commit drop as
  select a.id as ad_id, coalesce(a.variant_label, left(a.id::text, 4)) as label,
         a.status,
         coalesce((select sum(i.views) from public.ad_impressions i where i.ad_id = a.id), 0)::numeric as views,
         greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0)::numeric as likes,
         coalesce((select sum(ds.quick_skips) from public.post_daily_stats ds where ds.post_id = p.id), 0)::numeric as quick,
         coalesce((select -sum(ch.amount_pence) from public.ad_charges ch
                   where ch.ad_id = a.id and ch.amount_pence < 0), 0)::numeric as spend
  from public.ads a
  join public.posts p on p.id = a.post_id
  left join public.post_bot_counts bc on bc.post_id = p.id
  where a.test_id = _test_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ad_id', ad_id, 'label', label, 'status', status,
           'views', views, 'likes', likes,
           'like_rate', case when views > 0 then round(likes / views, 4) end,
           'quick_skip_rate', case when views > 0 then round(quick / views, 4) end,
           'spend_pence', spend,
           'cost_per_like_pence', case when likes > 0 then round(spend / likes, 1) end
         ) order by case when views > 0 then likes / views end desc nulls last), '[]'::jsonb)
    into _variants from _ab;

  select bool_and(views >= _min) and count(*) >= 2 into _ready from _ab;

  if _ready then
    select * into _best from _ab where views > 0 order by likes / views desc limit 1;
    select * into _second from _ab where views > 0 and ad_id <> _best.ad_id order by likes / views desc limit 1;
    if _second.ad_id is not null and _second.likes > 0 then
      _p := (_best.likes + _second.likes) / (_best.views + _second.views);
      if _p > 0 and _p < 1 then
        _z := ((_best.likes / _best.views) - (_second.likes / _second.views))
              / sqrt(_p * (1 - _p) * (1 / _best.views + 1 / _second.views));
        _conf := case when _z >= 2.33 then 'high' when _z >= 1.64 then 'medium' else 'low' end;
      end if;
      _lift := round(100 * ((_best.likes / _best.views) / nullif(_second.likes / _second.views, 0) - 1));
      _verdict := format('Version %s won: %s%% more people liked it', _best.label,
                         coalesce(_lift::text, '?'));
    end if;
  end if;

  return jsonb_build_object(
    'variants', _variants,
    'ready', coalesce(_ready, false),
    'min_views_per_variant', _min,
    'verdict', case when _ready and _conf <> 'low' then _verdict end,
    'leading', case when _ready then _verdict end,
    'confidence', case when _ready then _conf end,
    'winner_ad_id', case when _ready and _conf <> 'low' then _best.ad_id end);
end;
$$;

-- "Move the budget to the winner" (one tap, signed off): ends the losers.
create or replace function public.end_ab_losers(_test_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _biz uuid;
  _winner uuid;
  _report jsonb;
begin
  select c.account_id into _biz
  from public.ad_tests t
  join public.ad_sets s on s.id = t.ad_set_id
  join public.campaigns c on c.id = s.campaign_id
  where t.id = _test_id;
  if _biz is null or not public.has_team_role(_biz, array['admin','editor']) then
    raise exception 'not authorised';
  end if;
  _report := public.get_ad_test_report(_test_id);
  _winner := nullif(_report->>'winner_ad_id', '')::uuid;
  if _winner is null then
    raise exception 'No confident winner yet — keep the test running.';
  end if;
  update public.ads set status = 'ended'
   where test_id = _test_id and id <> _winner and status = 'active';
  update public.ad_tests
     set status = 'ended', winner_ad_id = _winner, ended_at = now()
   where id = _test_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- eligible_ads v2: audience kinds + brand-safety passthrough.
-- ---------------------------------------------------------------------------
-- The return type grows, so drop first. get_deck keeps working: it reads a
-- named-column subset (ad_id..broad) that the new shape still provides.
drop function public.eligible_ads(uuid);
create or replace function public.eligible_ads(_viewer uuid)
returns table (ad_id uuid, post_id uuid, cta_label text, cta_url text, campaign_id uuid, broad boolean,
               kind text, avoid_sensitive boolean, blocked_topics text[], blocked_creators uuid[])
language sql
stable
security definer
set search_path = ''
as $fn$
  with viewer as (
    select pr.id, pr.age_band, pr.ads_consent, pr.search_center_label,
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
    from public.profiles pr where pr.id = _viewer
  )
  select a.id, a.post_id, a.cta_label, a.cta_url, c.id,
         (s.audience_kind = 'standard'
          and cardinality(s.age_bands) = 0 and s.region_label is null
          and cardinality(s.tag_ids) = 0) as broad,
         case
           when s.audience_kind in ('engaged', 'similar') then s.audience_kind
           when cardinality(s.age_bands) = 0 and s.region_label is null
                and cardinality(s.tag_ids) = 0 then 'broad'
           else 'personalised'
         end as kind,
         s.avoid_sensitive, s.blocked_topics, s.blocked_creators
  from public.ads a
  join public.ad_sets s on s.id = a.ad_set_id
  join public.campaigns c on c.id = s.campaign_id
  join public.ad_accounts acc on acc.user_id = c.account_id
  join public.posts p on p.id = a.post_id
  cross join viewer v
  where a.status = 'active' and s.status = 'active' and c.status = 'active'
    and acc.status = 'active' and acc.balance_pence > 0
    and 'deck' = any(s.placements)
    and now() >= s.starts_at and (s.ends_at is null or now() < s.ends_at)
    and p.visibility = 'ad' and p.moderation_status = 'approved'
    and p.user_id <> _viewer
    -- CONSENT WALL (8D): personalised targeting only for consenting adults.
    -- Part 13C: engaged/similar audiences are personalised BY DEFINITION, so
    -- they sit entirely behind the same wall, and only validated sets
    -- (audience >= the 50-person floor at validation time) ever serve.
    and (
      (s.audience_kind = 'standard'
       and cardinality(s.age_bands) = 0 and s.region_label is null and cardinality(s.tag_ids) = 0)
      or (
        v.age_band = 'adult' and v.ads_consent = 'personalised'
        and (
          (s.audience_kind = 'standard'
           and (cardinality(s.age_bands) = 0 or v.band = any(s.age_bands))
           and (s.region_label is null or v.search_center_label = s.region_label)
           and (cardinality(s.tag_ids) = 0 or exists (
                 select 1 from public.user_tags ut
                 where ut.user_id = v.id and ut.weight > 0 and ut.tag_id = any(s.tag_ids))))
          or (s.audience_kind = 'engaged'
              and s.audience_validated_at is not null
              and exists (
                select 1 from public.swipes sw
                join public.posts ep on ep.id = sw.post_id
                where sw.user_id = v.id and sw.direction = 'right'
                  and ep.user_id = c.account_id
                  and sw.created_at > now() - make_interval(days => s.engaged_days)))
          or (s.audience_kind = 'similar'
              and s.audience_validated_at is not null
              and not exists (
                select 1 from public.swipes sw
                join public.posts ep on ep.id = sw.post_id
                where sw.user_id = v.id and sw.direction = 'right'
                  and ep.user_id = c.account_id
                  and sw.created_at > now() - make_interval(days => s.engaged_days))
              and exists (
                select 1 from public.user_tags vt
                where vt.user_id = v.id and vt.weight > 0
                  and vt.tag_id in (
                    select ut.tag_id
                    from public.swipes sw
                    join public.posts ep on ep.id = sw.post_id
                    join public.user_tags ut on ut.user_id = sw.user_id and ut.weight > 0
                    where ep.user_id = c.account_id and sw.direction = 'right'
                      and sw.created_at > now() - make_interval(days => s.engaged_days)
                    group by ut.tag_id
                    order by count(distinct sw.user_id) desc
                    limit public.setting_numeric('similar_top_tags', 5)::integer)))
        )
      )
    )
    and not exists (select 1 from public.ad_hides h
                    where h.user_id = _viewer and h.ad_id = a.id)
    -- Frequency cap per CAMPAIGN per day (8C).
    and coalesce((
      select sum(i.views) from public.ad_impressions i
      join public.ads a2 on a2.id = i.ad_id and a2.ad_set_id in
        (select s2.id from public.ad_sets s2 where s2.campaign_id = c.id)
      where i.user_id = _viewer and i.day = (now() at time zone 'Europe/London')::date
    ), 0) < public.setting_numeric('ad_frequency_cap_daily', 3)
    -- Pacing: stop when today's spend reaches the daily budget (or total).
    and coalesce((
      select -sum(ch.amount_pence) from public.ad_charges ch
      join public.ads a3 on a3.id = ch.ad_id
      where a3.ad_set_id = s.id and ch.amount_pence < 0
        and ch.created_at >= date_trunc('day', now() at time zone 'Europe/London')
    ), 0) < s.budget_daily_pence
    and (s.budget_total_pence is null or coalesce((
      select -sum(ch.amount_pence) from public.ad_charges ch
      join public.ads a4 on a4.id = ch.ad_id
      where a4.ad_set_id = s.id and ch.amount_pence < 0
    ), 0) < s.budget_total_pence);
$fn$;

revoke all on function public.validate_ad_set_audience(uuid) from public, anon, authenticated;
revoke all on function public.get_ad_test_report(uuid) from public, anon, authenticated;
revoke all on function public.end_ab_losers(uuid) from public, anon, authenticated;
grant execute on function public.validate_ad_set_audience(uuid) to authenticated;
grant execute on function public.get_ad_test_report(uuid) to authenticated;
grant execute on function public.end_ab_losers(uuid) to authenticated;
