-- Rollback for 20261125470000_ab_retargeting.
-- Run the 20261125480000 rollback FIRST so get_deck no longer reads ea.kind.
-- Dropping these columns/tables discards A/B tests and audience settings
-- created since the migration (flagged per Part 0).

drop function if exists public.end_ab_losers(uuid);
drop function if exists public.get_ad_test_report(uuid);
drop function if exists public.validate_ad_set_audience(uuid);

alter table public.ads drop column if exists variant_label, drop column if exists test_id;
drop table if exists public.ad_tests;

-- eligible_ads back to v1 (return type shrinks: drop first).
drop function public.eligible_ads(uuid);
create or replace function public.eligible_ads(_viewer uuid)
returns table (ad_id uuid, post_id uuid, cta_label text, cta_url text, campaign_id uuid, broad boolean)
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
         (cardinality(s.age_bands) = 0 and s.region_label is null
          and cardinality(s.tag_ids) = 0) as broad
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
    and (
      (cardinality(s.age_bands) = 0 and s.region_label is null and cardinality(s.tag_ids) = 0)
      or (
        v.age_band = 'adult' and v.ads_consent = 'personalised'
        and (cardinality(s.age_bands) = 0 or v.band = any(s.age_bands))
        and (s.region_label is null or v.search_center_label = s.region_label)
        and (cardinality(s.tag_ids) = 0 or exists (
              select 1 from public.user_tags ut
              where ut.user_id = v.id and ut.weight > 0 and ut.tag_id = any(s.tag_ids)))
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

alter table public.ad_sets
  drop column if exists blocked_creators,
  drop column if exists blocked_topics,
  drop column if exists avoid_sensitive,
  drop column if exists audience_validated_at,
  drop column if exists engaged_days,
  drop column if exists audience_kind;

delete from public.platform_settings where key in ('ab_min_views_per_variant', 'similar_top_tags');
