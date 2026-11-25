-- Part 10 (security review, step 1 of 2): own-profile reads via a function.
--
-- Prepares for 20261125400000_profiles_column_privacy (the column-level
-- SELECT revoke). This half is applied immediately — it only ADDS the
-- function the new client uses, so live clients are unaffected. The revoke
-- half must wait until no client calling select('*') on profiles remains
-- (see that file's header).

create or replace function public.get_my_profile()
returns public.profiles
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.profiles where id = auth.uid();
$$;
revoke all on function public.get_my_profile() from public, anon, authenticated;
grant execute on function public.get_my_profile() to authenticated;
