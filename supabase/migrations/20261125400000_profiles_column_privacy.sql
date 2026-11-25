-- Part 10 (security review, step 2 of 2): profiles column privacy.
--
-- ⚠ STAGED — DO NOT APPLY until every distributed client uses
--   get_my_profile() for own-row reads (the Part 10 build). Clients that
--   still `select('*')` from profiles get permission-denied after this.
--
-- FINDING (launch security review): profiles granted table-wide SELECT to
-- authenticated (policy: any non-blocked profile), so ANY signed-in user
-- could read ANY user's date_of_birth (exact DOB — under-18 data),
-- search_location (exact coordinates of their chosen search centre),
-- points balances, consent state and terms timestamps. UPDATE was already
-- column-restricted; SELECT was not.
--
-- FIX: SELECT is re-granted column-by-column for the public surface only.
-- Own-row full reads use get_my_profile() (20261125390000). Server-side
-- paths (definer functions, service role, fame-admin) are unaffected.

revoke select on table public.profiles from authenticated;
grant select (
  id, handle, display_name, bio, avatar_url,
  is_private, verified, account_type, account_status,
  age_band, created_at, category
) on table public.profiles to authenticated;
