-- Part 13E: business profile extras — opening hours, menu/booking links,
-- offers (moderated), and privacy-safe business insights.

insert into public.platform_settings (key, value, description, client_visible) values
  ('business_offers_max_active', to_jsonb(3), 'Most offers a business can have live at once.', false)
on conflict (key) do nothing;

-- Hours + action links live on the business profile row. Written only
-- through set_business_details (team admin/editor), read through the
-- venue/business card functions below.
alter table public.profiles
  add column business_hours jsonb
    check (business_hours is null or (jsonb_typeof(business_hours) = 'object'
           and pg_column_size(business_hours) < 4096)),
  add column menu_url text check (menu_url is null or char_length(menu_url) <= 500),
  add column booking_url text check (booking_url is null or char_length(booking_url) <= 500);

create or replace function public._check_business_link(_url text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _domain text;
begin
  if _url is null then return; end if;
  if _url !~* '^https://' then
    raise exception 'Links must start with https://';
  end if;
  _domain := lower(regexp_replace(_url, '^https?://(www\.)?([^/:]+).*$', '\2', 'i'));
  if exists (select 1 from public.link_domain_blocklist b
             where b.active and (_domain = b.domain or _domain like '%.' || b.domain)) then
    raise exception 'That link cannot be added.';
  end if;
end;
$$;

create or replace function public.set_business_details(
  _business uuid, _hours jsonb, _menu_url text, _booking_url text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.has_team_role(_business, array['admin','editor']) then
    raise exception 'not authorised';
  end if;
  if (select account_type from public.profiles where id = _business) <> 'business' then
    raise exception 'Only business accounts have these details.';
  end if;
  perform public._check_business_link(_menu_url);
  perform public._check_business_link(_booking_url);
  update public.profiles
     set business_hours = _hours,
         menu_url = nullif(btrim(coalesce(_menu_url, '')), ''),
         booking_url = nullif(btrim(coalesce(_booking_url, '')), '')
   where id = _business;
end;
$$;

-- ---------------------------------------------------------------------------
-- Offers: short-lived promotions shown on the business profile and on the
-- venue's map card (only for VERIFIED venue claims). Text is moderated like
-- any other publish; a flagged offer is held, never shown.
-- ---------------------------------------------------------------------------
create table public.offers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(btrim(title)) between 1 and 80),
  details     text check (details is null or char_length(details) <= 300),
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  status      text not null default 'active' check (status in ('active', 'ended', 'held')),
  created_by  uuid not null default auth.uid(),
  created_at  timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index offers_business on public.offers (business_id, status);
alter table public.offers enable row level security;
revoke all on table public.offers from public, anon, authenticated;
grant select on table public.offers to authenticated;
-- The team sees everything (held included); the public reads through the
-- security-definer card functions, which filter to live offers.
create policy offers_team on public.offers
  for select to authenticated
  using (public.has_team_role(business_id, array['admin','editor','analyst','moderator']));

create or replace function public.create_offer(
  _business uuid, _title text, _details text, _ends_at timestamptz)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _max integer := public.setting_numeric('business_offers_max_active', 3)::integer;
  _verdict text;
  _status text := 'active';
  _id uuid;
begin
  if not public.has_team_role(_business, array['admin','editor']) then
    raise exception 'not authorised';
  end if;
  if (select account_type from public.profiles where id = _business) <> 'business' then
    raise exception 'Only business accounts can post offers.';
  end if;
  if (select count(*) from public.offers
      where business_id = _business and status = 'active'
        and (ends_at is null or ends_at > now())) >= _max then
    raise exception 'You can have up to % live offers. End one first.', _max;
  end if;
  _verdict := public.moderate_text(coalesce(_title, '') || ' ' || coalesce(_details, ''));
  if _verdict = 'removed' then
    raise exception 'This offer can''t be posted. Please reword it.';
  elsif _verdict = 'flagged' then
    _status := 'held';  -- surfaced to the team as held, never shown publicly
  end if;
  insert into public.offers (business_id, title, details, ends_at, status, created_by)
  values (_business, btrim(_title), nullif(btrim(coalesce(_details, '')), ''), _ends_at, _status, auth.uid())
  returning id into _id;
  return _id;
end;
$$;

create or replace function public.end_offer(_offer_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _biz uuid;
begin
  select business_id into _biz from public.offers where id = _offer_id;
  if _biz is null or not public.has_team_role(_biz, array['admin','editor']) then
    raise exception 'not authorised';
  end if;
  update public.offers set status = 'ended' where id = _offer_id;
end;
$$;

-- Live offers for a business profile screen.
create or replace function public.get_business_offers(_business uuid)
returns table (id uuid, title text, details text, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.title, o.details, o.ends_at
  from public.offers o
  join public.profiles pr on pr.id = o.business_id
  where o.business_id = _business
    and o.status = 'active'
    and o.starts_at <= now()
    and (o.ends_at is null or o.ends_at > now())
    and pr.account_status = 'active'
  order by o.created_at desc;
$$;

-- The map place card: the VERIFIED claiming business (if any), its hours,
-- action links and live offers. Venue location is already public — this
-- adds nothing about any user's whereabouts.
create or replace function public.get_venue_business(_venue_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'business_id', pr.id,
    'handle', pr.handle,
    'display_name', pr.display_name,
    'avatar_url', pr.avatar_url,
    'business_hours', pr.business_hours,
    'menu_url', pr.menu_url,
    'booking_url', pr.booking_url,
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'title', o.title, 'details', o.details, 'ends_at', o.ends_at)
             order by o.created_at desc)
      from public.offers o
      where o.business_id = pr.id and o.status = 'active'
        and o.starts_at <= now() and (o.ends_at is null or o.ends_at > now())
    ), '[]'::jsonb))
  from public.business_venues bv
  join public.profiles pr on pr.id = bv.business_id
  where bv.venue_id = _venue_id and bv.verified
    and pr.account_status = 'active' and pr.account_type = 'business'
  limit 1;
$$;

-- Hours/links for a business profile screen (same fields, by business id).
create or replace function public.get_business_extras(_business uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'business_hours', pr.business_hours,
    'menu_url', pr.menu_url,
    'booking_url', pr.booking_url)
  from public.profiles pr
  where pr.id = _business and pr.account_type = 'business'
    and pr.account_status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- Business insights: how people reach and use the business surfaces.
-- PRIVACY: viewer_id exists only to count each person once per day and is
-- never readable by any client role; everything a business sees is a plain
-- daily count per kind — no identities, no demographics, nothing about who.
-- ---------------------------------------------------------------------------
create table public.business_insight_events (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.profiles (id) on delete cascade,
  viewer_id   uuid not null,
  kind        text not null check (kind in
    ('profile_view', 'hours_view', 'menu_click', 'booking_click', 'offer_view', 'offer_click')),
  day         date not null default ((now() at time zone 'Europe/London')::date),
  created_at  timestamptz not null default now()
);
create unique index business_insight_dedupe
  on public.business_insight_events (business_id, viewer_id, kind, day);
alter table public.business_insight_events enable row level security;
revoke all on table public.business_insight_events from public, anon, authenticated;
-- no policies: definer functions only

create or replace function public.record_business_insight(_business uuid, _kind text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or _business is null then return; end if;
  if auth.uid() = _business
     or public.has_team_role(_business, array['admin','editor','analyst','moderator']) then
    return;  -- the team looking at itself is not an insight
  end if;
  insert into public.business_insight_events (business_id, viewer_id, kind)
  values (_business, auth.uid(), _kind)
  on conflict do nothing;
exception when check_violation then
  null;  -- unknown kind: drop silently rather than error a view render
end;
$$;

create or replace function public.get_business_insights(_business uuid, _days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _since date := (now() at time zone 'Europe/London')::date - greatest(least(coalesce(_days, 30), 90), 1);
  _daily jsonb;
  _totals jsonb;
begin
  if not public.has_team_role(_business, array['admin','editor','analyst','moderator']) then
    raise exception 'not authorised';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'kind', d.kind, 'n', d.n)
                            order by d.day, d.kind), '[]'::jsonb)
    into _daily
  from (select e.day, e.kind, count(*)::integer as n
        from public.business_insight_events e
        where e.business_id = _business and e.day >= _since
        group by e.day, e.kind) d;
  select coalesce(jsonb_object_agg(t.kind, t.n), '{}'::jsonb)
    into _totals
  from (select e.kind, count(*)::integer as n
        from public.business_insight_events e
        where e.business_id = _business and e.day >= _since
        group by e.kind) t;
  return jsonb_build_object('since', _since, 'daily', _daily, 'totals', _totals);
end;
$$;

revoke all on function public._check_business_link(text) from public, anon, authenticated;
revoke all on function public.set_business_details(uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.create_offer(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.end_offer(uuid) from public, anon, authenticated;
revoke all on function public.get_business_offers(uuid) from public, anon, authenticated;
revoke all on function public.get_venue_business(uuid) from public, anon, authenticated;
revoke all on function public.get_business_extras(uuid) from public, anon, authenticated;
revoke all on function public.record_business_insight(uuid, text) from public, anon, authenticated;
revoke all on function public.get_business_insights(uuid, integer) from public, anon, authenticated;
grant execute on function public.set_business_details(uuid, jsonb, text, text) to authenticated;
grant execute on function public.create_offer(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.end_offer(uuid) to authenticated;
grant execute on function public.get_business_offers(uuid) to authenticated;
grant execute on function public.get_venue_business(uuid) to authenticated;
grant execute on function public.get_business_extras(uuid) to authenticated;
grant execute on function public.record_business_insight(uuid, text) to authenticated;
grant execute on function public.get_business_insights(uuid, integer) to authenticated;
