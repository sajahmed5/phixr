-- Rollback for 20261125260000_teen_protections.
-- Restores the pre-Part-6 search_accounts/recommended_accounts and removes
-- the teen-privacy trigger, is_minor helper, age-assurance column and
-- settings. NOTE: roll back 20261125270000 FIRST (its policies and fns call
-- is_minor).

set search_path = public, extensions;

drop trigger if exists profiles_teen_privacy on public.profiles;
drop function if exists public.tg_profiles_teen_privacy();

create or replace function public.search_accounts(_q text, _limit integer default 20, _offset integer default 0)
returns table(id uuid, handle text, display_name text, avatar_url text,
              follower_count integer, is_private boolean, follow_status text)
language sql stable security definer set search_path = '' as $fn$
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
  order by
    (lower(pr.handle) = lower(_q)) desc,
    extensions.similarity(pr.handle, _q) desc,
    (select count(*) from public.follows f where f.followee_id = pr.id and f.status = 'accepted') desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;

create or replace function public.recommended_accounts(_limit integer default 10)
returns table(id uuid, handle text, display_name text, avatar_url text,
              follower_count integer, is_private boolean, follow_status text)
language sql stable security definer set search_path = '' as $fn$
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

drop function if exists public.is_minor(uuid);
alter table public.profiles drop column if exists age_assured_at;

delete from public.platform_settings where key in (
  'teen_posts_in_adult_deck', 'teen_quiet_start_hour', 'teen_quiet_end_hour',
  'teen_time_reminder_minutes', 'signup_age_retry_days', 'age_assurance_provider');
