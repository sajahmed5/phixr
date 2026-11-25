-- Part 8 (core): the advertising platform — campaign structure, consent,
-- serving data, genuine-only billing.
--
-- THE REUSE DECISION: an ad's creative IS a posts row with visibility 'ad'.
--   * Organic surfaces all filter visibility = 'public', so ad posts can
--     never leak into the deck/search/feeds organically.
--   * The media pipeline, text moderation, appeals, swipes (record_swipe —
--     brief 8C: "recorded exactly like posts"), bot-cleaning, view events
--     and the Part 3 roll-ups all just work on them — which is exactly what
--     8E's reporting needs.
--
-- DECIDED WITH SAJ: billing is Stripe-READY, keys later — the charging
-- ledger, VAT fields and balances are real; top-ups are manual fame-admin
-- credits until Stripe keys exist (a webhook then just adds credits the
-- same way). Pay-per-like is behind the ads_pay_per_like_enabled flag.
--
-- CONSENT (8D, UK GDPR/PECR): profiles.ads_consent 'unset' | 'personalised'
-- | 'non_personalised', set via set_ads_consent (timestamped). Personalised
-- targeting only ever reaches CONSENTING ADULTS. Minors and non-consenting
-- adults are served only BROAD ad sets (no age/region/interest targeting) —
-- nothing about the person is used. Minors never appear in advertiser data
-- (8E excludes them entirely).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Settings.
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description, client_visible) values
  ('ad_cpm_pence',             '500'::jsonb, 'Price per 1,000 genuine ad views (CPM), pence.', false),
  ('ad_cpc_pence',             '30'::jsonb,  'Price per genuine ad click, pence.', false),
  ('ad_cpl_pence',             '50'::jsonb,  'Price per genuine right-swipe on an ad (pay-per-like), pence.', false),
  ('ads_pay_per_like_enabled', '0'::jsonb,   'Feature flag (brief 8B): 1 lets ad sets choose the pay-per-like pricing model.', false),
  ('ad_frequency_cap_daily',   '3'::jsonb,   'Max times one campaign reaches the same user per day (brief 8C).', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Ad creatives are posts: visibility gains 'ad'.
-- ---------------------------------------------------------------------------
alter table public.posts drop constraint posts_visibility_check;
alter table public.posts add constraint posts_visibility_check
  check (visibility in ('public', 'private', 'groups', 'ad'));

-- Readable when approved (the deck serves them; tapping opens the creative).
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
        or (visibility = 'ad' and moderation_status = 'approved')
        or (visibility = 'private' and public.is_accepted_follower_of(user_id))
        or (visibility = 'groups'
            and public.is_accepted_follower_of(user_id)
            and public.viewer_in_post_groups(id))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Consent (8D).
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column ads_consent text not null default 'unset'
    check (ads_consent in ('unset', 'personalised', 'non_personalised')),
  add column ads_consent_at timestamptz;

create or replace function public.set_ads_consent(_choice text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if _choice not in ('personalised', 'non_personalised') then
    raise exception 'set_ads_consent: bad choice';
  end if;
  -- Minors can never consent to personalised ads (brief 6A/8D).
  if _choice = 'personalised' and public.is_minor(auth.uid()) then
    raise exception 'set_ads_consent: personalised ads are 18+';
  end if;
  update public.profiles
     set ads_consent = _choice, ads_consent_at = now()
   where id = auth.uid();
end;
$fn$;
revoke all on function public.set_ads_consent(text) from public, anon;
grant execute on function public.set_ads_consent(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The campaign structure (8A/8B).
-- ---------------------------------------------------------------------------
create table public.ad_accounts (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  business_name text not null,
  vat_number    text,
  country       text not null default 'GB',
  balance_pence bigint not null default 0,
  status        text not null default 'active' check (status in ('active', 'paused')),
  created_at    timestamptz not null default now()
);

create table public.campaigns (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.ad_accounts (user_id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  goal       text not null check (goal in
               ('reach', 'likes', 'profile_visits', 'website_clicks', 'venue_visits')),
  status     text not null default 'draft' check (status in ('draft', 'active', 'paused', 'ended')),
  created_at timestamptz not null default now()
);
create index campaigns_account on public.campaigns (account_id, created_at desc);

create table public.ad_sets (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references public.campaigns (id) on delete cascade,
  name               text not null check (char_length(btrim(name)) between 1 and 80),
  -- Targeting (18+ bands ONLY; empty everything = a BROAD set, the only kind
  -- minors or non-consenting adults ever receive).
  age_bands          text[] not null default '{}',
  region_label       text,
  tag_ids            uuid[] not null default '{}',
  placements         text[] not null default '{deck}',
  pricing_model      text not null default 'cpm' check (pricing_model in ('cpm', 'cpc', 'cpl')),
  budget_daily_pence integer not null check (budget_daily_pence > 0),
  budget_total_pence integer,
  starts_at          timestamptz not null default now(),
  ends_at            timestamptz,
  status             text not null default 'active' check (status in ('active', 'paused', 'ended')),
  created_at         timestamptz not null default now(),
  constraint ad_sets_adult_bands check (
    age_bands <@ array['18-24','25-34','35-44','45-54','55+']::text[])
);
create index ad_sets_campaign on public.ad_sets (campaign_id);

create table public.ads (
  id         uuid primary key default gen_random_uuid(),
  ad_set_id  uuid not null references public.ad_sets (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  cta_label  text not null default 'Learn more' check (char_length(cta_label) <= 24),
  cta_url    text,
  status     text not null default 'active' check (status in ('active', 'paused', 'ended')),
  created_at timestamptz not null default now(),
  unique (post_id)
);
create index ads_set on public.ads (ad_set_id);

-- Internal serving/billing records. NEVER app-readable: individual exposure
-- data stays inside the database (brief 8E: no individual data, ever).
create table public.ad_impressions (
  ad_id   uuid not null references public.ads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  day     date not null,
  views   integer not null default 0,
  primary key (ad_id, user_id, day)
);

create table public.ad_clicks (
  id         uuid primary key default gen_random_uuid(),
  ad_id      uuid not null references public.ads (id) on delete cascade,
  user_id    uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  charged    boolean not null default false
);
create index ad_clicks_billing on public.ad_clicks (ad_id, charged);

create table public.ad_hides (
  user_id uuid not null references public.profiles (id) on delete cascade,
  ad_id   uuid not null references public.ads (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, ad_id)
);

create table public.ad_charges (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.ad_accounts (user_id) on delete cascade,
  ad_id      uuid references public.ads (id) on delete set null,
  kind       text not null check (kind in ('impressions', 'clicks', 'likes', 'credit', 'stripe_topup')),
  qty        integer not null default 1,
  amount_pence integer not null,   -- negative = spend, positive = credit
  note       text,
  created_at timestamptz not null default now()
);
create index ad_charges_account on public.ad_charges (account_id, created_at desc);
create index ad_charges_ad_day on public.ad_charges (ad_id, created_at);

-- Billing watermark (singleton row).
create table public.ad_billing_cursor (
  id smallint primary key default 1 check (id = 1),
  last_run timestamptz not null default now()
);
insert into public.ad_billing_cursor (id) values (1);

-- RLS: advertisers manage their own tree; serving/billing tables are sealed.
alter table public.ad_accounts     enable row level security;
alter table public.campaigns       enable row level security;
alter table public.ad_sets         enable row level security;
alter table public.ads             enable row level security;
alter table public.ad_impressions  enable row level security;
alter table public.ad_clicks       enable row level security;
alter table public.ad_hides        enable row level security;
alter table public.ad_charges      enable row level security;
alter table public.ad_billing_cursor enable row level security;

create policy ad_accounts_own on public.ad_accounts
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy campaigns_own on public.campaigns
  for all to authenticated
  using (account_id = auth.uid()) with check (account_id = auth.uid());
create policy ad_sets_own on public.ad_sets
  for all to authenticated
  using (exists (select 1 from public.campaigns c
                 where c.id = campaign_id and c.account_id = auth.uid()))
  with check (exists (select 1 from public.campaigns c
                      where c.id = campaign_id and c.account_id = auth.uid()));
create policy ads_own on public.ads
  for all to authenticated
  using (exists (select 1 from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
                 where s.id = ad_set_id and c.account_id = auth.uid()))
  with check (exists (select 1 from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
                      where s.id = ad_set_id and c.account_id = auth.uid()));
create policy ad_charges_own_select on public.ad_charges
  for select to authenticated using (account_id = auth.uid());
create policy ad_hides_own on public.ad_hides
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.ad_accounts, public.campaigns, public.ad_sets, public.ads,
              public.ad_impressions, public.ad_clicks, public.ad_hides,
              public.ad_charges, public.ad_billing_cursor
  from public, anon, authenticated;
grant select, insert, update on public.ad_accounts to authenticated;
grant select, insert, update, delete on public.campaigns to authenticated;
grant select, insert, update, delete on public.ad_sets to authenticated;
grant select, insert, update, delete on public.ads to authenticated;
grant select on public.ad_charges to authenticated;
grant select, insert, delete on public.ad_hides to authenticated;

-- Minors can never open an ad account (brief 8B: targeting is 18+;
-- advertising is a paid partnership in spirit — adults only).
create or replace function public.tg_ad_accounts_adult()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if public.is_minor(new.user_id) then
    raise exception 'Ad accounts are for over-18s.';
  end if;
  return new;
end;
$fn$;
revoke all on function public.tg_ad_accounts_adult() from public, anon, authenticated;
create trigger ad_accounts_adult
  before insert on public.ad_accounts
  for each row execute function public.tg_ad_accounts_adult();

-- Pay-per-like stays flagged off (brief 8B): refuse 'cpl' unless enabled.
create or replace function public.tg_ad_sets_cpl_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.pricing_model = 'cpl'
     and public.setting_numeric('ads_pay_per_like_enabled', 0) <> 1 then
    raise exception 'Pay-per-like is not available yet.';
  end if;
  return new;
end;
$fn$;
revoke all on function public.tg_ad_sets_cpl_flag() from public, anon, authenticated;
create trigger ad_sets_cpl_flag
  before insert or update of pricing_model on public.ad_sets
  for each row execute function public.tg_ad_sets_cpl_flag();

-- ---------------------------------------------------------------------------
-- 5. Interactions: clicks, hide, report reuses the posts report flow.
-- ---------------------------------------------------------------------------
create or replace function public.record_ad_click(_ad_id uuid)
returns void
language sql
security definer
set search_path = ''
as $fn$
  insert into public.ad_clicks (ad_id, user_id)
  select a.id, auth.uid() from public.ads a where a.id = _ad_id and a.status = 'active';
$fn$;
revoke all on function public.record_ad_click(uuid) from public, anon;
grant execute on function public.record_ad_click(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Billing (8E: only GENUINE events are charged): every 15 minutes, turn
--    new unflagged ad views / clicks / right-swipes into charges at the
--    settings prices, respecting the flag for pay-per-like. Serving (below)
--    stops when the daily budget or the balance runs out — the pacing the
--    brief asks for, enforced at the spend ledger.
-- ---------------------------------------------------------------------------
create or replace function public.run_ads_billing()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _from timestamptz;
  _now  timestamptz := now();
  _cpm  numeric := public.setting_numeric('ad_cpm_pence', 500);
  _cpc  numeric := public.setting_numeric('ad_cpc_pence', 30);
  _cpl  numeric := public.setting_numeric('ad_cpl_pence', 50);
begin
  select last_run into _from from public.ad_billing_cursor where id = 1 for update;

  -- CPM: genuine (unflagged) tracked views on ad posts in the window.
  insert into public.ad_charges (account_id, ad_id, kind, qty, amount_pence)
  select c.account_id, a.id, 'impressions', count(*),
         -ceil(count(*) * _cpm / 1000.0)::integer
  from public.post_view_events e
  join public.ads a on a.post_id = e.post_id
  join public.ad_sets s on s.id = a.ad_set_id and s.pricing_model = 'cpm'
  join public.campaigns c on c.id = s.campaign_id
  where e.shown_at > _from and e.shown_at <= _now and not e.flagged
  group by c.account_id, a.id
  having ceil(count(*) * _cpm / 1000.0) > 0;

  -- CPL (flagged feature): genuine right swipes on ad posts.
  if public.setting_numeric('ads_pay_per_like_enabled', 0) = 1 then
    insert into public.ad_charges (account_id, ad_id, kind, qty, amount_pence)
    select c.account_id, a.id, 'likes', count(*), -(count(*) * _cpl)::integer
    from public.post_view_events e
    join public.ads a on a.post_id = e.post_id
    join public.ad_sets s on s.id = a.ad_set_id and s.pricing_model = 'cpl'
    join public.campaigns c on c.id = s.campaign_id
    where e.shown_at > _from and e.shown_at <= _now
      and not e.flagged and e.direction = 'right'
    group by c.account_id, a.id;
  end if;

  -- CPC: uncharged clicks.
  insert into public.ad_charges (account_id, ad_id, kind, qty, amount_pence)
  select c.account_id, a.id, 'clicks', count(*), -(count(*) * _cpc)::integer
  from public.ad_clicks k
  join public.ads a on a.id = k.ad_id
  join public.ad_sets s on s.id = a.ad_set_id and s.pricing_model = 'cpc'
  join public.campaigns c on c.id = s.campaign_id
  where not k.charged
  group by c.account_id, a.id;
  update public.ad_clicks set charged = true where not charged;

  -- Settle balances for everything just written.
  update public.ad_accounts acc
     set balance_pence = acc.balance_pence + sums.delta
    from (select account_id, sum(amount_pence) as delta
          from public.ad_charges
          where created_at > _from and amount_pence < 0
          group by account_id) sums
   where acc.user_id = sums.account_id;

  update public.ad_billing_cursor set last_run = _now where id = 1;
end;
$fn$;
revoke all on function public.run_ads_billing() from public, anon, authenticated;

select cron.schedule('ads-billing', '4,19,34,49 * * * *',
                     $$select public.run_ads_billing();$$)
where not exists (select 1 from cron.job where jobname = 'ads-billing');

-- ---------------------------------------------------------------------------
-- 7. Serving eligibility: the one place the consent/targeting/budget/cap
--    rules live. Used by get_deck's ad slot (next migration).
-- ---------------------------------------------------------------------------
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
revoke all on function public.eligible_ads(uuid) from public, anon, authenticated;
