-- Part 7C: business accounts.
--
--   * profiles.account_type 'personal' | 'business', switched by RPC (adults
--     only — minors can't do paid partnerships, brief 6A).
--   * business_venues: a business claims one or more venues (chains claim
--     every branch). A venue with a VERIFIED claim can't be claimed by
--     anyone else; unverified claims never block other claimants.
--   * Verification = Google Business Profile sign-in EVENTUALLY; Google
--     requires an API application, so (per the brief) the shipped flow is
--     the MANUAL fallback: fame-admin verifies a claim by hand
--     (business_venues.verified, audited). The Google OAuth flow should set
--     the same columns via an Edge Function when API access is approved —
--     verification_method records which path verified it.
--   * Business posts auto-link to the venue when the business has exactly
--     one claimed venue; chain posts stay unlinked and surface at the branch
--     nearest the searcher (search_posts_local v2, 20261125290000).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Account type.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column account_type text not null default 'personal'
    check (account_type in ('personal', 'business'));

create or replace function public.set_account_type(_type text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare _uid uuid := auth.uid();
begin
  if _type not in ('personal', 'business') then
    raise exception 'set_account_type: bad type';
  end if;
  if _type = 'business' and exists (
    select 1 from public.profiles pr where pr.id = _uid and pr.age_band = 'minor'
  ) then
    raise exception 'set_account_type: business accounts are 18+';
  end if;
  update public.profiles set account_type = _type where id = _uid;
  -- Dropping back to personal releases every venue claim.
  if _type = 'personal' then
    delete from public.business_venues where business_id = _uid;
  end if;
end;
$fn$;
revoke all on function public.set_account_type(text) from public, anon;
grant execute on function public.set_account_type(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Venue claims.
-- ---------------------------------------------------------------------------
create table public.business_venues (
  business_id uuid not null references public.profiles (id) on delete cascade,
  venue_id    uuid not null references public.venues (id) on delete cascade,
  verified    boolean not null default false,
  verification_method text check (verification_method in ('manual', 'google')),
  verified_at timestamptz,
  verified_by uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  primary key (business_id, venue_id)
);
-- One VERIFIED owner per venue, ever.
create unique index business_venues_one_verified_owner
  on public.business_venues (venue_id) where verified;

alter table public.business_venues enable row level security;
-- Claims are public-readable (the badge and "owned by" need it); writes via RPC.
create policy business_venues_select on public.business_venues
  for select to authenticated using (true);
revoke all on table public.business_venues from public, anon, authenticated;
grant select on public.business_venues to authenticated;

create or replace function public.claim_venue(_venue_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare _uid uuid := auth.uid();
begin
  if not exists (select 1 from public.profiles pr
                 where pr.id = _uid and pr.account_type = 'business') then
    raise exception 'claim_venue: switch to a business account first';
  end if;
  if not exists (select 1 from public.venues v where v.id = _venue_id) then
    raise exception 'claim_venue: unknown venue';
  end if;
  -- A venue with a verified owner is spoken for (brief 7C).
  if exists (select 1 from public.business_venues bv
             where bv.venue_id = _venue_id and bv.verified and bv.business_id <> _uid) then
    raise exception 'claim_venue: this venue is owned by a verified business';
  end if;
  insert into public.business_venues (business_id, venue_id)
  values (_uid, _venue_id)
  on conflict (business_id, venue_id) do nothing;
end;
$fn$;
revoke all on function public.claim_venue(uuid) from public, anon;
grant execute on function public.claim_venue(uuid) to authenticated;

create or replace function public.unclaim_venue(_venue_id uuid)
returns void
language sql
security definer
set search_path = ''
as $fn$
  delete from public.business_venues
  where business_id = auth.uid() and venue_id = _venue_id;
$fn$;
revoke all on function public.unclaim_venue(uuid) from public, anon;
grant execute on function public.unclaim_venue(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Business posts auto-link their venue (single-venue businesses).
--    Runs BEFORE the search-vector trigger alphabetically ('aa_' < 'tg_'),
--    so the vector indexes the linked venue on the same insert.
-- ---------------------------------------------------------------------------
create or replace function public.tg_posts_business_venue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare _only_venue uuid;
begin
  if new.venue_id is null and exists (
    select 1 from public.profiles pr
    where pr.id = new.user_id and pr.account_type = 'business'
  ) then
    select case when count(*) = 1 then min(venue_id::text)::uuid end into _only_venue
    from public.business_venues bv where bv.business_id = new.user_id;
    if _only_venue is not null then
      new.venue_id := _only_venue;
    end if;
  end if;
  return new;
end;
$fn$;
revoke all on function public.tg_posts_business_venue() from public, anon, authenticated;
create trigger aa_posts_business_venue
  before insert on public.posts
  for each row execute function public.tg_posts_business_venue();
