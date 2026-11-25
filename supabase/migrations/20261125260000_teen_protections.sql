-- Part 6A: teen accounts.
--
-- Already enforced before this migration (verified in Part 6 review):
--   * Under-13s cannot exist: tg_profiles_age_band raises on INSERT/UPDATE
--     with a DOB under 13 (DB-level, not just UI).
--   * Minors can never share a DM conversation with an adult (membership
--     trigger). DECIDED WITH SAJ: this TOTAL block stays, deliberately
--     stricter than the brief's "no DMs from adults they don't follow".
--   * Venue tagging is blocked for minors; boosts can't be bought by minors
--     or target them (Part 5); minors never appear in likers-list brand data
--     (Part 4 note) and the ads parts must keep them out of ad data.
--
-- This migration adds:
--   1. Private BY DEFAULT for under-18 signups (DB trigger, not UI).
--   2. Adults can't find minors in Accounts search unless already connected,
--      and minors are never suggested to adults.
--   3. Teen-wellbeing settings (quiet hours, time reminder) + the under-13
--      retry-cooldown setting the signup screen reads.
--   4. The age-assurance hook the UK Online Safety Act work will plug into:
--      profiles.age_assured_at + an 'age_assurance_provider' setting. When a
--      provider is integrated, its callback should stamp age_assured_at and
--      may correct date_of_birth; nothing else in the schema needs to move.
--   (Minors' posts leaving adults' DISCOVERY surfaces is in 20261125270000,
--    which re-emits get_deck/get_discover once for teen + sensitive rules.)

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Settings.
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description, client_visible) values
  ('teen_posts_in_adult_deck',    '0'::jsonb,  'When 1, minors'' public posts may appear in adults'' discovery deck. Default 0 per brief 6A (admins may review later).', false),
  ('teen_quiet_start_hour',       '22'::jsonb, 'Hour (0-23, device time) when the teen quiet-hours banner starts.', true),
  ('teen_quiet_end_hour',         '7'::jsonb,  'Hour (0-23, device time) when teen quiet hours end.', true),
  ('teen_time_reminder_minutes',  '60'::jsonb, 'Continuous minutes of teen use before the gentle time reminder shows.', true),
  ('signup_age_retry_days',       '7'::jsonb,  'Days the signup screen keeps an under-13 refusal before allowing another date of birth on the same device.', true),
  ('age_assurance_provider',      '0'::jsonb,  'Age-assurance hook (0 = none). When a provider is wired in, its id goes here and signups above a risk threshold get routed through it.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Age-assurance hook column (OSA): stamped by a future provider callback.
-- ---------------------------------------------------------------------------
alter table public.profiles add column age_assured_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Who is a minor (reusable, definer so RLS policies and fns can ask).
-- ---------------------------------------------------------------------------
create or replace function public.is_minor(_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce((select pr.age_band = 'minor' from public.profiles pr where pr.id = _user), false);
$fn$;
revoke all on function public.is_minor(uuid) from public, anon;
grant execute on function public.is_minor(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Minors are PRIVATE BY DEFAULT (server-side, on account creation only —
--    a teen may still choose public afterwards, per "default", not "locked").
-- ---------------------------------------------------------------------------
create or replace function public.tg_profiles_teen_privacy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.date_of_birth is not null
     and extract(year from age(new.date_of_birth)) < 18 then
    new.is_private := true;
    new.require_follow_approval := true;
  end if;
  return new;
end;
$fn$;
revoke all on function public.tg_profiles_teen_privacy() from public, anon, authenticated;
create trigger profiles_teen_privacy
  before insert on public.profiles
  for each row execute function public.tg_profiles_teen_privacy();

-- ---------------------------------------------------------------------------
-- 5. Accounts search: adults only find minors they are already connected to
--    (an accepted follow in either direction).
-- ---------------------------------------------------------------------------
create or replace function public.search_accounts(_q text, _limit integer default 20, _offset integer default 0)
returns table(id uuid, handle text, display_name text, avatar_url text,
              follower_count integer, is_private boolean, follow_status text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select pr.id, pr.handle, pr.display_name, pr.avatar_url,
    (select count(*)::int from public.follows f where f.followee_id = pr.id and f.status = 'accepted'),
    pr.is_private,
    (select f.status from public.follows f where f.follower_id = auth.uid() and f.followee_id = pr.id)
  from public.profiles pr
  where _q <> ''
    and pr.id <> auth.uid()
    and pr.account_status = 'active'
    and (pr.handle ilike '%' || _q || '%' or pr.display_name ilike '%' || _q || '%')
    and not exists (select 1 from public.blocks b
                    where (b.blocker_id = auth.uid() and b.blocked_id = pr.id)
                       or (b.blocker_id = pr.id and b.blocked_id = auth.uid()))
    -- Teen shield (brief 6A): adults only see minors they're connected with.
    and (pr.age_band = 'adult'
         or public.is_minor(auth.uid())
         or exists (select 1 from public.follows f
                    where f.status = 'accepted'
                      and ((f.follower_id = auth.uid() and f.followee_id = pr.id)
                        or (f.follower_id = pr.id and f.followee_id = auth.uid()))))
  order by
    (lower(pr.handle) = lower(_q)) desc,
    extensions.similarity(pr.handle, _q) desc,
    (select count(*) from public.follows f where f.followee_id = pr.id and f.status = 'accepted') desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Suggestions: minors are never recommended to adults, full stop.
-- ---------------------------------------------------------------------------
create or replace function public.recommended_accounts(_limit integer default 10)
returns table(id uuid, handle text, display_name text, avatar_url text,
              follower_count integer, is_private boolean, follow_status text)
language sql
stable
security definer
set search_path = ''
as $fn$
  with my_tags as (
    select pt.tag_id, count(*)::int as weight
    from public.swipes s
    join public.post_tags pt on pt.post_id = s.post_id
    where s.user_id = auth.uid() and s.direction = 'right'
    group by pt.tag_id
  ),
  candidates as (
    select pr.id,
      coalesce((
        select sum(mt.weight)::bigint
        from public.posts p
        join public.post_tags pt on pt.post_id = p.id
        join my_tags mt on mt.tag_id = pt.tag_id
        where p.user_id = pr.id
          and p.moderation_status = 'approved'
      ), 0) as score,
      (select count(*)::int from public.follows f
        where f.followee_id = pr.id and f.status = 'accepted') as followers
    from public.profiles pr
    where pr.id <> auth.uid()
      and pr.account_status = 'active'
      -- Teen shield (brief 6A): never suggest a minor to an adult.
      and (pr.age_band = 'adult' or public.is_minor(auth.uid()))
      and not exists (select 1 from public.follows f
                      where f.follower_id = auth.uid() and f.followee_id = pr.id)
      and not exists (select 1 from public.blocks b
                      where (b.blocker_id = auth.uid() and b.blocked_id = pr.id)
                         or (b.blocker_id = pr.id and b.blocked_id = auth.uid()))
      and exists (select 1 from public.posts p
                  where p.user_id = pr.id and p.moderation_status = 'approved')
  )
  select pr.id, pr.handle, pr.display_name, pr.avatar_url,
    c.followers, pr.is_private,
    null::text as follow_status
  from candidates c
  join public.profiles pr on pr.id = c.id
  order by c.score desc, c.followers desc, pr.created_at desc
  limit greatest(_limit, 0);
$fn$;
