-- Part 7C (addendum): claim a place straight from the places picker.
-- The app's venue picker returns provider place data (no venues row yet for
-- places nobody has posted at), so claiming upserts the venue then claims it
-- under the same rules as claim_venue.

set search_path = public, extensions;

create or replace function public.claim_place(
  _provider text,
  _provider_place_id text,
  _name text,
  _category text default null,
  _lat double precision default null,
  _lon double precision default null,
  _address text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid uuid := auth.uid();
  _venue uuid;
begin
  if not exists (select 1 from public.profiles pr
                 where pr.id = _uid and pr.account_type = 'business') then
    raise exception 'claim_place: switch to a business account first';
  end if;
  if coalesce(btrim(_provider_place_id), '') = '' or coalesce(btrim(_name), '') = '' then
    raise exception 'claim_place: missing place details';
  end if;

  insert into public.venues as v (provider, provider_place_id, name, category, lat, lon, address)
  values (coalesce(nullif(btrim(_provider), ''), 'google'), _provider_place_id, btrim(_name),
          nullif(btrim(coalesce(_category, '')), ''), _lat, _lon, nullif(btrim(coalesce(_address, '')), ''))
  on conflict (provider, provider_place_id) do update
    set name = excluded.name,
        category = coalesce(excluded.category, v.category),
        lat = coalesce(excluded.lat, v.lat),
        lon = coalesce(excluded.lon, v.lon),
        address = coalesce(excluded.address, v.address),
        updated_at = now()
  returning id into _venue;

  perform public.claim_venue(_venue);
  return _venue;
end;
$fn$;
revoke all on function public.claim_place(text, text, text, text, double precision, double precision, text)
  from public, anon;
grant execute on function public.claim_place(text, text, text, text, double precision, double precision, text)
  to authenticated;
